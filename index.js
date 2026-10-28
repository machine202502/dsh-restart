import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsStore } from './src/settings.js';

export const inject = ['tools'];


const obj = (properties = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});

/** Where the restart marker lives between the old and the new app process. */
const dataDir = () => (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hsb-restart')
  : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'hsb-restart'));

const markerPath = () => join(dataDir(), 'pending.json');
const failedPath = () => join(dataDir(), 'failed.json');
const bootPath = () => join(dataDir(), 'boot.json');
const watchdogPath = () => join(dataDir(), 'watchdog.json');

/** SHA-256 of the profile files a rollback would overwrite. */
const profileHashes = (profileDir) => {
  const out = {};
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    try {
      out[name] = createHash('sha256').update(readFileSync(join(profileDir, name))).digest('hex');
    } catch {
      // A missing file has no hash and is skipped on both sides.
    }
  }
  return out;
};
const backupRoot = () => join(dataDir(), 'backup');

/**
 * Session ids known to the workspace store.
 *
 * A finished subagent's Agent is disposed, so `agents.list()` no longer shows it
 * while its background jobs keep running. The session directories still do.
 */
const knownSessionIds = () => {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const root = join(home, 'sessions');
  const ids = new Set();
  try {
    // Every workspace: a finished subagent's job must be found no matter which
    // workspace key its session directory uses.
    for (const workspace of readdirSync(root)) {
      try {
        for (const name of readdirSync(join(root, workspace))) {
          // Top-level sessions are stored as `session-<uuid>`, subagent sessions
          // as the bare `<uuid>`: accept both and query both id forms.
          const isSession = name.startsWith('session-') || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name);
          if (!isSession) continue;
          ids.add(name);
          ids.add(name.startsWith('session-') ? name.slice('session-'.length) : `session-${name}`);
        }
      } catch {
        // Skip a workspace we cannot read.
      }
    }
  } catch {
    // No store yet: the live roster below still applies.
  }
  return [...ids];
};

const readMarker = () => {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const writeMarker = (marker) => {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(markerPath(), JSON.stringify(marker, null, 2));
};

const clearMarker = () => {
  try {
    rmSync(markerPath(), { force: true });
  } catch {
    // Nothing to remove.
  }
};

/**
 * Copy the profile's user-editable layers next to the restart marker.
 * Those are the files that make the app unbootable when they are wrong.
 */
const backupProfile = (profileDir, name) => {
  const target = join(backupRoot(), name);
  try {
    mkdirSync(target, { recursive: true });
    for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      try {
        writeFileSync(join(target, file), readFileSync(join(profileDir, file)));
      } catch {
        // A missing file simply is not part of the backup.
      }
    }
    return target;
  } catch {
    return null;
  }
};

/** Snapshot of the last configuration that actually started. */
const snapshotGood = (profileDir) => {
  try {
    const target = backupProfile(profileDir, 'last-good');
    if (target) {
      writeFileSync(join(backupRoot(), 'last.json'), JSON.stringify({
        good: target,
        at: new Date().toISOString(),
        profileDir,
      }, null, 2));
    }
  } catch {
    // Snapshotting must never break activation.
  }
};

/**
 * Restart the desktop app from an independent process.
 *
 * A child of the app dies with the `taskkill /T` tree it launches, so the
 * helper is registered as a one-shot scheduled task instead: Task Scheduler
 * owns it, it survives the shutdown, and it deletes the task afterwards.
 */
const runTask = (args) => new Promise((resolve) => {
  const child = spawn('schtasks.exe', args, { windowsHide: true });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => resolve({ code: -1, stderr: String(error.message ?? error) }));
  child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
});

const scheduleRestart = async ({ appPid, exe, profileDir, token = '', watchdogEnabled = true, watchdogSeconds = 10, delayMs = 1200 }) => {
  mkdirSync(dataDir(), { recursive: true });
  const helperPath = join(dataDir(), 'restart-helper.ps1');
  const logPath = join(dataDir(), 'restart.log');
  const taskName = 'HSB-Restart';
  const boot = bootPath();
  const failed = failedPath();
  // History copy of the current (possibly broken) files.
  backupProfile(profileDir, new Date().toISOString().replace(/[:.]/g, '-'));
  const good = join(backupRoot(), 'last-good');
  const backup = existsSync(good) ? good : null;
  const startedAt = new Date().toISOString();
  const timeoutSec = Math.min(120, Math.max(1, Number(watchdogSeconds) || 10));
  // Chromium keeps one auth cookie per launch; stale ones overflow the header
  // limit and break the welcome handshake (HTTP 431).
  const cookieScript = join(dirname(fileURLToPath(import.meta.url)), 'src', 'cookie-clean.py');

  const quote = (value) => String(value).replace(/'/g, "''");
  const helper = [
    "$ErrorActionPreference = 'Continue'",
    `$log = '${quote(logPath)}'`,
    `$boot = '${quote(boot)}'`,
    `$failed = '${quote(failed)}'`,
    `$backup = '${quote(backup ?? '')}'`,
    `$profile = '${quote(profileDir)}'`,
    `$exe = '${quote(exe)}'`,
    `$startedAt = [datetime]'${startedAt}'`,
    `$token = '${quote(token)}'`,
    `$watchdog = '${quote(watchdogPath())}'`,
    `$cookies = '${quote(cookieScript)}'`,
    "function Purge-Cookies {",
    "  $candidate = Join-Path $env:USERPROFILE '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'",
    "  if (Test-Path -LiteralPath $candidate) { $python = $candidate } else { $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }",
    "  if ($python -and (Test-Path -LiteralPath $cookies)) { & $python $cookies 2>&1 | ForEach-Object { Log ([string]$_) } } else { Log 'cookie cleanup skipped: python or script missing' }",
    "}",
    "function AuthFailureSince($since) {",
    "  $dir = Join-Path $env:APPDATA '@deepseek-ai\\dsh-desktop\\logs'",
    "  if (-not (Test-Path -LiteralPath $dir)) { return $false }",
    "  $file = Get-ChildItem -LiteralPath $dir -Filter 'crash-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1",
    "  if (-not $file -or $file.LastWriteTime -lt $since) { return $false }",
    "  return [bool](Select-String -LiteralPath $file.FullName -Pattern 'Web authentication failed' -Quiet)",
    "}",
    "function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $m) }",
    "function FreshBoot($since) {",
    "  if (-not (Test-Path $boot)) { return $false }",
    "  try { $b = Get-Content -LiteralPath $boot -Raw | ConvertFrom-Json; return ([datetime]$b.at -gt $since) } catch { return $false }",
    "}",
    "function HashesMatch {",
    "  if (-not (Test-Path $watchdog)) { return $false }",
    "  try {",
    "    $state = Get-Content -LiteralPath $watchdog -Raw | ConvertFrom-Json",
    "    if ($state.token -ne $token) { return $false }",
    "    foreach ($name in @('package.json', 'cordis.patch.yml', 'cordis.yml')) {",
    "      $expected = $state.hashes.$name",
    "      if ($null -eq $expected -or $expected -eq '') { continue }",
    "      $path = Join-Path $profile $name",
    "      if (-not (Test-Path -LiteralPath $path)) { return $false }",
    "      $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash",
    "      if ($actual -ne $expected) { return $false }",
    "    }",
    "    return $true",
    "  } catch { return $false }",
    "}",
    "function Wait-Healthy($since) {",
    `  $deadline = (Get-Date).AddSeconds(${timeoutSec})`,
    "  while ((Get-Date) -lt $deadline) {",
    "    if (FreshBoot $since) { return $true }",
    "    Start-Sleep -Seconds 3",
    "  }",
    "  return $false",
    "}",
    "function Kill-App { & \"$env:SystemRoot\\System32\\taskkill.exe\" /IM 'DeepSeek Harness.exe' /T /F *>> $log }",
    "Log 'watchdog start'",
    `Start-Sleep -Milliseconds ${delayMs}`,
    `& "$env:SystemRoot\\System32\\taskkill.exe" /PID ${appPid} /T /F *>> $log`,
    "Log 'killed'",
    "Start-Sleep -Milliseconds 1500",
    "Purge-Cookies",
    "Start-Process -FilePath $exe",
    "Log 'started'",
    "if (Wait-Healthy $startedAt) { Log 'healthy'; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'HSB-Restart' /F *>> $log; exit 0 }",
    "if (AuthFailureSince $startedAt) {",
    "  Log 'auth failure detected: purged stale cookies, retrying the start'",
    "  Purge-Cookies",
    "  Start-Process -FilePath $exe",
    "  if (Wait-Healthy $startedAt) { Log 'healthy after cookie purge'; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'HSB-Restart' /F *>> $log; exit 0 }",
    "  Log 'still failing after the cookie purge'",
    "}",
    "if (-not (HashesMatch)) { Log 'token invalidated or files changed manually: skipping the rollback'; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'HSB-Restart' /F *>> $log; exit 0 }",
    "Log 'timeout: rolling back the profile backup'",
    "if ($backup -ne '' -and (Test-Path $backup)) { Copy-Item -Path (Join-Path $backup '*') -Destination $profile -Force -Recurse -ErrorAction SilentlyContinue }",
    "$payload = ConvertTo-Json @{ failed = $true; at = (Get-Date).ToString('o') }",
    "[System.IO.File]::WriteAllText($failed, $payload, (New-Object System.Text.UTF8Encoding($false)))",
    "Kill-App",
    "Start-Sleep -Milliseconds 2000",
    "$rollbackAt = Get-Date",
    "Start-Process -FilePath $exe",
    "Log 'restarted after rollback'",
    "if (Wait-Healthy $rollbackAt) { Log 'healthy after rollback'; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'HSB-Restart' /F *>> $log; exit 0 }",
    "Log 'still failing: disabling the third-party restart bundle'",
    "$pkgPath = Join-Path $profile 'package.json'",
    "try {",
    "  $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json",
    "  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'hsb-restart' })",
    "  $json = $pkg | ConvertTo-Json -Depth 12",
    "  [System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))",
    "  Log 'hsb-restart bundle removed from the profile'",
    "} catch { Log ('disable failed: ' + $_) }",
    "Kill-App",
    "Start-Sleep -Milliseconds 2000",
    "Start-Process -FilePath $exe",
    "Log 'started without the plugin'",
    "& \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'HSB-Restart' /F *>> $log",
  ].join('\r\n');
  writeFileSync(helperPath, helper);

  if (process.platform === 'win32' && watchdogEnabled === false) {
    const plain = [
      "$ErrorActionPreference = 'Continue'",
      `$log = '${logPath.replace(/'/g, "''")}'`,
      "Add-Content -LiteralPath $log -Value ('plain restart ' + (Get-Date -Format o))",
      `Start-Sleep -Milliseconds ${delayMs}`,
      `& "$env:SystemRoot\\System32\\taskkill.exe" /PID ${appPid} /T /F *>> $log`,
      "Start-Sleep -Milliseconds 1500",
      "$candidate = Join-Path $env:USERPROFILE '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'",
      "if (Test-Path -LiteralPath $candidate) { $python = $candidate } else { $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }",
      `$scripts = '${cookieScript.replace(/'/g, "''")}'`,
      "if ($python -and (Test-Path -LiteralPath $scripts)) { & $python $scripts 2>&1 | ForEach-Object { Add-Content -LiteralPath $log -Value ([string]$_) } }",
      `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`,
      "& \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'HSB-Restart' /F *>> $log",
    ].join('\r\n');
    writeFileSync(helperPath, plain);
    const create = await runTask([
      '/Create', '/F', '/IT', '/TN', taskName, '/TR',
      `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${helperPath}"`,
      '/SC', 'ONCE', '/ST', '00:00',
    ]);
    if (create.code !== 0) throw new Error(`Windows Task Scheduler refused the restart task: ${create.stderr.trim() || create.code}`);
    const run = await runTask(['/Run', '/TN', taskName]);
    if (run.code !== 0) throw new Error(`could not start the restart task: ${run.stderr.trim() || run.code}`);
    return;
  }

  if (process.platform === 'win32') {
    const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${helperPath}"`;
    const create = await runTask([
      '/Create', '/F', '/IT', '/TN', taskName, '/TR', command, '/SC', 'ONCE', '/ST', '00:00',
    ]);
    if (create.code !== 0) {
      throw new Error(`Windows Task Scheduler refused the restart task: ${create.stderr.trim() || `exit code ${create.code}`}`);
    }
    const run = await runTask(['/Run', '/TN', taskName]);
    if (run.code !== 0) {
      await runTask(['/Delete', '/TN', taskName, '/F']);
      throw new Error(`could not start the restart task: ${run.stderr.trim() || `exit code ${run.code}`}`);
    }
    return;
  }

  const open = process.platform === 'darwin' ? `open -a "${exe}"` : `"${exe}" >/dev/null 2>&1 &`;
  const script = `sleep ${(delayMs / 1000).toFixed(1)}; kill -TERM ${appPid} 2>/dev/null; sleep 1; ${open}`;
  const launcher = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
  launcher.unref();
};

export function apply(ctx, config = {}) {
  const port = config.bridgePort ?? 49233;

  // The profile patch is the deployment default; the form writes overrides.
  const settingsStore = createSettingsStore(dataDir());
  const effective = () => settingsStore.merge({
    toolEnabled: config.toolEnabled !== false,
    watchdogEnabled: config.watchdogEnabled !== false,
    watchdogSeconds: Number.isFinite(config.watchdogSeconds) ? Number(config.watchdogSeconds) : 10,
  });

  const profileDir = (() => {
    try {
      const context = ctx.get?.('profileContext');
      const dir = context?.dir ?? context?.directory ?? context?.path ?? context?.profileDir;
      if (typeof dir === 'string' && dir.length > 0) return dir;
    } catch {
      // Fall through to the conventional location.
    }
    return join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop');
  })();

  // Last configuration that booted successfully: the rollback target.
  snapshotGood(profileDir);

  // Proof of a healthy boot for the restart watchdog; also invalidates the
  // restart token, so a watchdog from an earlier restart cannot touch this run.
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(bootPath(), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }));
    rmSync(watchdogPath(), { force: true });
  } catch {
    // The marker is only used by the watchdog.
  }

  // DSH drops a job record when the Agent that started it is disposed, while
  // the job keeps running. Remember every started job ourselves so a finished
  // subagent cannot hide its background work from the preflight.
  const trackedJobs = new Map();
  let jobsService;
  const installTracking = () => {
    if (!jobsService || typeof jobsService.start !== 'function' || jobsService.__hsbRestartTracked === true) return;
    const originalStart = jobsService.start.bind(jobsService);
    jobsService.start = (spec, ...rest) => {
      const jobId = originalStart(spec, ...rest);
      try {
        const id = String(jobId?.id ?? jobId ?? '');
        if (id) trackedJobs.set(id, { id, sessionId: spec?.owner ?? null, status: 'running' });
      } catch {
        // Tracking must never break job creation.
      }
      return jobId;
    };
    jobsService.__hsbRestartTracked = true;
  };
  try {
    jobsService = ctx.get?.('jobs');
  } catch {
    jobsService = undefined;
  }
  const tryInstall = () => {
    if (!jobsService) {
      try {
        jobsService = ctx.get?.('jobs');
      } catch {
        jobsService = undefined;
      }
    }
    installTracking();
    return Boolean(jobsService);
  };
  tryInstall();
  if (!jobsService) {
    // The registry may come from a plugin that mounts after this one: wait for it.
    const timer = setInterval(() => {
      if (tryInstall()) clearInterval(timer);
    }, 500);
    const stop = setTimeout(() => clearInterval(timer), 60000);
    try {
      ctx.effect(() => () => {
        clearInterval(timer);
        clearTimeout(stop);
      });
    } catch {
      // Timers without a disposer are harmless here.
    }
  }

  const trackedRunning = () => {
    const running = [];
    for (const [id, record] of trackedJobs) {
      try {
        const job = jobsService?.get?.(record.id, record.sessionId);
        const status = job?.status ?? 'running';
        if (status === 'running' || status === 'stopping') running.push({ ...record, status });
        else trackedJobs.delete(id);
      } catch {
        // The registry no longer knows the job: it finished or was reaped.
        trackedJobs.delete(id);
      }
    }
    return running;
  };
  const exe = process.execPath;
  const appPid = process.ppid;

  const request = async (options) => {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const marker = {
      // A restart always resumes the session: the chat gets "continue".
      continue: true,
      token,
      sessionId: typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null,
      at: new Date().toISOString(),
      reason: options.reason ?? 'manual',
    };
    // Only the agent tool resumes the session; a manual restart from the
    // sidebar just brings the app back.
    if (options.continue === false) clearMarker();
    else writeMarker(marker);
    // The watchdog is bound to this restart only: any later boot or restart
    // replaces/removes this file, and the stale watchdog then does nothing.
    writeFileSync(watchdogPath(), JSON.stringify({
      token,
      at: marker.at,
      sessionId: marker.sessionId,
      // A rollback is only safe while the files are still the ones this
      // restart started from; any manual edit cancels it.
      hashes: profileHashes(profileDir),
    }, null, 2));
    try {
      await scheduleRestart({ appPid, exe, profileDir, token, ...effective() });
    } catch (error) {
      clearMarker();
      throw error;
    }
    return marker;
  };

  // Diagnostics: did the client bundle actually initialize in this page?
  const seen = { clientLoaded: 0, pendingReads: 0, lastClientAt: null };

  // Small local bridge: the sidebar button and the "continue" flow read and
  // write the same marker the tool uses.
  const server = createServer((req, res) => {
    const allow = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, allow);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { ...allow, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(payload);
    };

    if (req.method === 'GET' && url.pathname === '/settings') {
      send(200, {
        values: effective(),
        defaults: {
          toolEnabled: config.toolEnabled !== false,
          watchdogEnabled: config.watchdogEnabled !== false,
          watchdogSeconds: Number.isFinite(config.watchdogSeconds) ? Number(config.watchdogSeconds) : 10,
        },
        file: settingsStore.file,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/settings') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          settingsStore.write(parsed);
          syncTool();
          send(200, { ok: true, values: effective() });
        } catch (error) {
          send(400, { ok: false, error: String(error.message ?? error) });
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/claim') {
      // Atomic: only one page load may consume the restart marker, so a double
      // boot cannot post the auto message twice.
      const marker = readMarker();
      if (marker) clearMarker();
      let failed = false;
      try {
        failed = existsSync(failedPath());
        if (failed) rmSync(failedPath(), { force: true });
      } catch {
        failed = false;
      }
      let queued = false;
      if (marker?.sessionId) {
        try {
          const agent = ctx.get?.('agents')?.get?.(marker.sessionId);
          const inbox = agent?.inbox;
          queued = (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0;
        } catch {
          queued = false;
        }
      }
      send(200, { marker, queued, failed });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/pending') {
      seen.pendingReads += 1;
      send(200, { pending: readMarker(), seen });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/diag') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        try {
          const file = join(dataDir(), 'client.log');
          mkdirSync(dataDir(), { recursive: true });
          writeFileSync(file, `${new Date().toISOString()} ${body}\n`, { flag: 'a' });
        } catch {
          // Diagnostics must never break the flow.
        }
        send(200, { ok: true });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/client-loaded') {
      seen.clientLoaded += 1;
      seen.lastClientAt = new Date().toISOString();
      send(200, { ok: true, seen });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true, appPid, exe, seen });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/restart' || url.pathname === '/consumed')) {
      if (url.pathname === '/consumed') {
        clearMarker();
        send(200, { ok: true });
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', async () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          send(400, { ok: false, error: 'invalid json' });
          return;
        }
        try {
          if (parsed.fake === true) {
            send(200, { ok: true, fake: true, marker: null });
            return;
          }
          const marker = await request({ sessionId: parsed.sessionId, reason: 'ui', continue: false });
          send(200, { ok: true, marker });
        } catch (error) {
          send(500, { ok: false, error: String(error.message ?? error) });
        }
      });
      return;
    }

    send(404, { ok: false, error: 'not found' });
  });
  server.keepAliveTimeout = 1000;

  // Start the bridge after activation returns: a busy port must never keep the
  // plugin entry in the "loading" state and block the web boot.
  let listening = false;
  const startBridge = () => {
    if (listening) return;
    try {
      server.on('error', (error) => {
        listening = false;
        ctx.logger?.warn?.(`hsb-restart: bridge unavailable: ${error.message}`);
      });
      server.listen(port, '127.0.0.1', () => { listening = true; });
    } catch (error) {
      ctx.logger?.warn?.(`hsb-restart: bridge failed: ${error.message}`);
    }
  };
  setImmediate(startBridge);
  ctx.effect(() => () => {
    try {
      server.close();
      server.closeAllConnections?.();
    } catch {
      // Already closed.
    }
  });

  ctx.tools.register({
    name: 'hsb_restart_status',
    description: 'Report what hsb_restart checks: permission preset, live sessions, and background jobs.',
    parameters: obj({}),
    output: {
      schema: obj({ report: { type: 'string' } }, ['report']),
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const agent = exec?.agent;
      const service = (name) => {
        try { return ctx.get?.(name); } catch { return undefined; }
      };
      const presets = service('permissionPresets');
      const preset = presets?.current?.(agent?.session) ?? 'unknown';
      let live = [];
      try { live = service('agents')?.list?.() ?? []; } catch { live = []; }
      const jobs = service('jobs');
      const globalJobs = (() => {
        try { return jobs?.list?.() ?? []; } catch { return []; }
      })();
      const perAgent = live.map((other) => ({
        id: other?.id,
        status: other?.status,
        nextTurn: other?.inbox?.nextTurn?.length ?? 0,
        nextStep: other?.inbox?.nextStep?.length ?? 0,
        jobs: (() => {
          try { return (jobs?.list?.(other.id) ?? []).map((job) => `${job.id}:${job.status}`); } catch { return ['<error>']; }
        })(),
      }));
      return {
        report: JSON.stringify({
          me: agent?.id ?? null,
          preset,
          jobsService: Boolean(jobsService),
          tracked: [...trackedJobs.keys()],
          live: perAgent,
          globalJobs: globalJobs.map((job) => `${job.id}:${job.status}:${job.sessionId ?? job.agentId ?? '?'}`),
        }, null, 2),
      };
    },
  });

  // The settings form can hide the tool; attempts to call it then fail with a
  // clear error because the registration is gone.
  let disposeRestart = null;
  const syncTool = () => {
    const enabled = effective().toolEnabled !== false;
    if (enabled && disposeRestart === null) {
      const dispose = registerRestartTool();
      disposeRestart = typeof dispose === 'function' ? dispose : null;
    } else if (!enabled && disposeRestart) {
      disposeRestart();
      disposeRestart = null;
    }
  };

  const registerRestartTool = () => ctx.tools.register({
    name: 'hsb_restart',
    description:
      'Restart the DeepSeek Harness desktop app. Use it after changing plugin code or profile configuration that only takes effect on a fresh start. '
      + 'The session is reopened afterwards and the message [auto.continue] is posted so the work resumes.',
    parameters: obj({
      fake: {
        type: 'boolean',
        description: 'Run every preflight check but do not restart the app (for testing the guards)',
      },
    }),
    output: {
      schema: obj({
        restarted: { type: 'boolean' },
        sessionId: { type: 'string' },
        detail: { type: 'string' },
      }, ['restarted']),
      render: (_args, value) => [{ type: 'text', text: value.detail ?? 'restarting DeepSeek Harness' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const agent = exec?.agent;
      const service = (name) => {
        try {
          return ctx.get?.(name);
        } catch {
          return undefined;
        }
      };

      // 1. Full access only: a restart kills whatever else is mid-flight.
      const presets = service('permissionPresets');
      const preset = presets?.current?.(agent?.session);
      if (preset !== undefined && preset !== 'danger-full-access') {
        throw new Error(
          `hsb_restart requires the Full access permission preset (current: ${String(preset)}). `
          + 'Switch to Full access, or restart the app manually.',
        );
      }

      // 2. No other active sessions or subagents: only the calling agent may work.
      const agents = service('agents');
      let live = [];
      try {
        live = agents?.list?.() ?? [];
      } catch {
        live = [];
      }
      const busy = live.filter((other) => {
        if (!other || other === agent || other.id === agent?.id) return false;
        const status = other.status;
        const nextTurn = other.inbox?.nextTurn?.length ?? 0;
        const nextStep = other.inbox?.nextStep?.length ?? 0;
        return status === 'running' || nextTurn > 0 || nextStep > 0;
      });
      if (busy.length > 0) {
        throw new Error(
          `hsb_restart refused: ${busy.length} other session(s) or subagent(s) are still working `
          + `(${busy.map((other) => other.id).join(', ')}). Wait for them to finish.`,
        );
      }

      // 3. No running background jobs: the global roster plus every live session.
      // A finished subagent can leave a job behind, so per-agent listing alone is
      // not enough.
      const jobs = service('jobs');
      const running = [];
      const seenJobs = new Set();
      const collect = (job) => {
        if (!job) return;
        if (job.status !== 'running' && job.status !== 'stopping') return;
        const key = String(job.id ?? '');
        if (key && seenJobs.has(key)) return;
        if (key) seenJobs.add(key);
        running.push(job);
      };
      try {
        for (const job of jobs?.list?.() ?? []) collect(job);
      } catch {
        // No global roster in this build.
      }
      try {
        for (const job of trackedRunning()) collect(job);
      } catch {
        // Tracking is best effort.
      }
      try {
        const ids = new Set();
        for (const other of live) {
          if (!other?.id) continue;
          ids.add(other.id);
          ids.add(String(other.id).replace(/^session-/, ''));
        }
        for (const id of knownSessionIds()) ids.add(id);
        for (const id of ids) {
          for (const job of jobs?.list?.(id) ?? []) collect(job);
        }
      } catch {
        // A missing job registry must not block a restart.
      }
      if (running.length > 0) {
        throw new Error(
          `hsb_restart refused: ${running.length} background job(s) are still running `
          + `(${running.map((job) => job.id ?? 'job').join(', ')}). Wait for them to finish.`,
        );
      }

      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id ?? null;

      if (args.fake === true) {
        return {
          restarted: false,
          ...(sessionId ? { sessionId } : {}),
          detail: 'Preflight passed; fake restart requested, nothing was restarted.',
        };
      }

      const marker = await request({ sessionId, reason: 'tool' });
      return {
        restarted: true,
        ...(marker.sessionId ? { sessionId: marker.sessionId } : {}),
        detail: `Restarting DeepSeek Harness in a moment; this session will be reopened with "[auto.continue]"${sessionId ? ` (${sessionId})` : ''}.`,
      };
    },
  });

  syncTool();

}
