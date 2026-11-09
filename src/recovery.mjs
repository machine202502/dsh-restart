/**
 * Boot recovery for the restart watchdog.
 *
 * The PowerShell helper only kills the app, starts it again and calls this
 * module between attempts; every decision lives here so it can be tested
 * without restarting anything.
 *
 * Commands:
 *   wait <startedAt> <timeoutSeconds>   poll for a healthy boot, exit 0 or 1
 *   rollback                            restore the last good profile, quarantine suspects
 *   safe                                start with the core bundles only
 *   done <ok|fail>                      close the overlay with a verdict
 *   status                              print the recorded state as JSON
 *
 * A boot counts as healthy when the client wrote a fresh `boot.json` AND no
 * crash log appeared after the restart started. The second half is what the old
 * watchdog missed: a plugin can fail to activate while the client still boots,
 * which leaves the app running with a broken interface.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// `DSH_RESTART_DATA` points the script at a sandbox directory, so a rehearsal
// never writes failed/quarantine state into the live app's data folder.
const dataDir = () => process.env.DSH_RESTART_DATA ?? (
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-restart')
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsh-restart')
);

const bootPath = () => join(dataDir(), 'boot.json');
const clientReadyPath = () => join(dataDir(), 'client-ready.json');
const pendingProfilePath = () => join(dataDir(), 'pending-profile');
const prestartPath = () => join(dataDir(), 'prestart.json');
const overlayPath = () => join(dataDir(), 'overlay.json');
const failedPath = () => join(dataDir(), 'failed.json');
const quarantinePath = () => join(dataDir(), 'quarantine.json');
const safeModePath = () => join(dataDir(), 'safe-mode.json');
const backupRoot = () => join(dataDir(), 'backup');
const goodBackup = () => join(backupRoot(), 'last-good');
const logPath = () => join(dataDir(), 'restart.log');
const profileFiles = ['package.json', 'cordis.patch.yml', 'cordis.yml'];
const coreBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const writeJson = (file, value) => {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // A failed write must not stop recovery.
  }
};

const log = (message) => {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(logPath(), `${new Date().toISOString()} recovery: ${message}\n`, { flag: 'a' });
  } catch {
    // Logging is best effort.
  }
};

const overlay = (patch) => {
  const current = readJson(overlayPath()) ?? {};
  writeJson(overlayPath(), { ...current, ...patch, updatedAt: new Date().toISOString() });
};

/** Crash logs written by the desktop shell after the restart started. */
const crashDirs = () => {
  const dirs = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'logs'));
  }
  dirs.push(join(dataDir(), 'logs'));
  return dirs;
};

const freshCrashLogs = (since) => {
  const found = [];
  for (const dir of crashDirs()) {
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^crash-.*\.log$/i.test(name)) continue;
      const file = join(dir, name);
      try {
        const info = statSync(file);
        if (info.mtime.getTime() >= since) found.push({ file, at: info.mtime.toISOString(), size: info.size });
      } catch {
        // A log that disappeared is not a signal.
      }
    }
  }
  return found;
};

/** Entry names a boot crash blames, e.g. "<pkg>: loading" under "did not activate". */
const blamedEntries = (logs) => {
  const names = new Set();
  for (const entry of logs) {
    let text = '';
    try {
      text = readFileSync(entry.file, 'utf8');
    } catch {
      continue;
    }
    if (!/did not activate|web boot failed|renderer console/i.test(text)) continue;
    for (const match of text.matchAll(/^(\S+): (?:loading|activate|apply)\b/gmu)) names.add(match[1]);
    for (const match of text.matchAll(/^(\S+): (?:loading)$/gmu)) names.add(match[1]);
    const summary = text.match(/Error: web boot: (\d+) entr(?:y|ies) did not activate/iu);
    if (summary) names.add(`boot:${summary[1]}`);
  }
  return [...names];
};

const healthy = (since) => {
  // `boot.json` is written by the host half, which activates even when a client
  // entry fails — exactly the case that froze the app. The renderer's own
  // `/client-loaded` marker is the only proof that the window came up.
  const ready = readJson(clientReadyPath());
  if (ready === null || typeof ready.at !== 'string') return false;
  if (Date.parse(ready.at) < since) return false;
  return freshCrashLogs(since).length === 0;
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Two callers: the PowerShell helper passes "done ok" as one token, the POSIX
// helper passes it as two arguments. Accept both shapes here instead of
// complicating the generated scripts.
const args = process.argv.slice(2);
const parts = String(args[0] ?? 'status').trim().split(/\s+/u);
const command = parts[0];
const verdict = parts[1] ?? args[1] ?? '';
const mode = parts[2] ?? args[2] ?? (verdict === 'ok' ? 'ok' : 'failed');

if (command === 'wait') {
  const rawSince = String(args[1] ?? 'now');
  const since = rawSince === 'now' ? Date.now() : Number(rawSince);
  const timeout = Math.max(5, Number(args[2] ?? 45));
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (healthy(since)) {
      // A failing client entry writes its crash log a moment after the renderer
      // reports in, so give it a short settle window before calling it healthy.
      sleep(2500);
      process.exit(freshCrashLogs(since).length > 0 ? 2 : 0);
    }
    sleep(1200);
  }
  // A crash log is the decisive signal; a missing marker is a softer one.
  process.exit(freshCrashLogs(since).length > 0 ? 2 : 1);
}

if (command === 'apply-profile') {
  // Written by `/profile/restore` while the app is still up, applied here while
  // it is down: a live loader would re-apply the whole tree and freeze.
  const dir = pendingProfilePath();
  const prestart = readJson(prestartPath()) ?? {};
  const profileDir = args[1] || prestart.profileDir || '';
  const applied = [];
  if (profileDir !== '' && existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      try {
        writeFileSync(join(profileDir, name), readFileSync(join(dir, name)));
        rmSync(join(dir, name), { force: true });
        applied.push(name);
      } catch (error) {
        log(`staged file ${name} failed: ${error?.message ?? error}`);
      }
    }
  }
  if (applied.length > 0) log(`applied staged profile files: ${applied.join(',')}`);
  process.exit(0);
}

if (command === 'rollback') {
  const prestart = readJson(prestartPath()) ?? {};
  const profileDir = prestart.profileDir ?? process.env.DSH_PROFILE_DIR ?? '';
  const since = Date.parse(prestart.startedAt ?? '') || 0;
  const logs = freshCrashLogs(since);
  const blamed = blamedEntries(logs);
  const packages = Array.isArray(prestart.packages) ? prestart.packages : [];

  // Suspects: plugins whose working tree changed since the last good boot, plus
  // the packages a crash log names. A dirty link package is the usual culprit.
  //
  // The watchdog itself is never a suspect: stashing this repository deletes
  // this very script mid-flight, and disabling the bundle also removes the
  // client half that resumes the chat after the restart.
  const PROTECTED = new Set(['dsh-restart', ...coreBundles]);
  const dirty = packages.filter((entry) => entry.dirty === true).map((entry) => entry.name);
  const named = packages
    .filter((entry) => blamed.some((name) => name === entry.name || name.startsWith(`${entry.name}/`)))
    .map((entry) => entry.name);
  const suspects = [...new Set([...dirty, ...named])].filter((name) => !PROTECTED.has(name));
  const reasons = [];
  if (blamed.length > 0) reasons.push(`boot blamed ${blamed.join(', ')}`);
  if (dirty.length > 0) reasons.push(`changed plugins ${dirty.join(', ')}`);
  if (logs.length > 0) reasons.push(`${logs.length} crash log(s)`);

  let restored = false;
  if (existsSync(goodBackup())) {
    try {
      for (const name of profileFiles) {
        const from = join(goodBackup(), name);
        if (!existsSync(from)) continue;
        writeFileSync(join(profileDir, name), readFileSync(from));
      }
      restored = true;
    } catch (error) {
      log(`profile restore failed: ${error?.message ?? error}`);
    }
  }

  // Preserve uncommitted work instead of deleting it: a stash is recoverable.
  const stashed = [];
  for (const entry of packages) {
    if (!suspects.includes(entry.name) || entry.dirty !== true || !entry.dir) continue;
    try {
      execFileSync('git', ['-C', entry.dir, 'stash', 'push', '--include-untracked', '-m', 'dsh-restart: rollback after a failed boot'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      stashed.push(entry.name);
    } catch (error) {
      log(`git stash failed for ${entry.name}: ${error?.message ?? error}`);
    }
  }

  const quarantined = [];
  if (profileDir !== '') {
    try {
      const file = join(profileDir, 'package.json');
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      const next = bundles.filter((name) => !suspects.includes(name));
      quarantined.push(...bundles.filter((name) => suspects.includes(name)));
      if (next.length !== bundles.length) {
        pkg.dsh.profile.bundles = next;
        writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
      }
    } catch (error) {
      log(`quarantine failed: ${error?.message ?? error}`);
    }
  }

  const previous = readJson(quarantinePath()) ?? { entries: [] };
  const entries = [...(previous.entries ?? [])];
  for (const name of quarantined) {
    if (!entries.some((entry) => entry.name === name)) {
      entries.push({ name, at: new Date().toISOString(), reason: reasons.join('; ') || 'failed boot', blamed });
    }
  }
  writeJson(quarantinePath(), { entries });

  writeJson(failedPath(), {
    failed: true,
    at: new Date().toISOString(),
    reason: reasons.join('; ') || 'the app did not become healthy',
    blamed,
    suspects,
    restored,
    stashed,
    quarantined,
    safeMode: false,
  });
  overlay({ phase: 'rollback', ok: false, detail: 'recovering', note: [restored ? 'profile' : '', quarantined.length ? `off ${quarantined.join(', ')}` : '', stashed.length ? `stash ${stashed.join(', ')}` : ''].filter(Boolean).join(', ') });
  log(`rollback: restored=${restored} suspects=${suspects.join(',') || 'none'} quarantined=${quarantined.join(',') || 'none'} stashed=${stashed.join(',') || 'none'}`);
  process.exit(0);
}

if (command === 'safe') {
  const prestart = readJson(prestartPath()) ?? {};
  const profileDir = prestart.profileDir ?? '';
  const removed = [];
  let ok = false;
  try {
    const file = join(profileDir, 'package.json');
    // A broken package.json is the worst case: parsing it throws before any of
    // the safe-mode rewrite can happen. Put the last good copy back first.
    let pkg = null;
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      const goodFile = join(goodBackup(), 'package.json');
      if (existsSync(goodFile)) {
        writeFileSync(file, readFileSync(goodFile));
        try {
          pkg = JSON.parse(readFileSync(file, 'utf8'));
          log('safe mode: package.json was unreadable, restored it from last-good');
        } catch {
          pkg = null;
        }
      }
    }
    if (pkg === null || typeof pkg !== 'object') {
      // No snapshot either: write the smallest profile that can still boot.
      pkg = { name: 'dsh-profile-desktop', private: true, dsh: { profile: { bundles: [...coreBundles] } } };
      removed.push('*unreadable package.json*');
      log('safe mode: package.json is unreadable and no snapshot exists, wrote a minimal profile');
    }
    pkg.dsh = pkg.dsh ?? {};
    pkg.dsh.profile = pkg.dsh.profile ?? {};
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    const kept = bundles.filter((name) => coreBundles.includes(name));
    removed.push(...bundles.filter((name) => !coreBundles.includes(name)));
    pkg.dsh.profile.bundles = kept.length > 0 ? kept : [...coreBundles];
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    ok = true;
  } catch (error) {
    log(`safe mode failed: ${error?.message ?? error}`);
  }
  writeJson(safeModePath(), { active: ok, at: new Date().toISOString(), removed });
  const previous = readJson(failedPath()) ?? {};
  writeJson(failedPath(), { ...previous, failed: true, safeMode: ok, reason: `${previous.reason ?? 'the app did not become healthy'}; safe mode` });
  overlay({ phase: 'safe-mode', ok: false, detail: 'safe-mode' });
  log(`safe mode: removed=${removed.join(',') || 'none'}`);
  process.exit(0);
}

if (command === 'mark-good') {
  // Called only after the helper verified a healthy boot: the previous snapshot
  // may belong to the configuration that just failed to start.
  const prestart = readJson(prestartPath()) ?? {};
  const profileDir = prestart.profileDir ?? '';
  if (profileDir !== '') {
    try {
      const target = goodBackup();
      mkdirSync(target, { recursive: true });
      for (const name of profileFiles) {
        try {
          writeFileSync(join(target, name), readFileSync(join(profileDir, name)));
        } catch {
          // A missing profile file is simply not part of the snapshot.
        }
      }
      writeJson(join(backupRoot(), 'last.json'), { good: target, at: new Date().toISOString(), profileDir });
      log('marked the current profile as good');
    } catch (error) {
      log(`mark-good failed: ${error?.message ?? error}`);
    }
  }
  rmSync(prestartPath(), { force: true });
  process.exit(0);
}

if (command === 'state') {
  const phase = String(args[1] ?? 'restart');
  overlay({
    phase,
    ok: false,
    detail: phase === 'rollback' ? 'recovering' : phase === 'safe-mode' ? 'safe' : '',
  });
  process.exit(0);
}

if (command === 'done') {
  const ok = verdict === 'ok';

  overlay({ phase: 'done', ok, detail: mode });
  log(`done: ${ok ? 'healthy' : 'failed'}`);
  process.exit(0);
}

// `status` and unknown commands print what the watchdog knows.
const prestart = readJson(prestartPath()) ?? {};
const since = Date.parse(prestart.startedAt ?? '') || 0;
console.log(JSON.stringify({
  dataDir: dataDir(),
  healthy: healthy(since),
  crashes: freshCrashLogs(since),
  blamed: blamedEntries(freshCrashLogs(since)),
  failed: readJson(failedPath()),
  quarantine: readJson(quarantinePath()),
  safeMode: readJson(safeModePath()),
  overlay: readJson(overlayPath()),
}, null, 2));
