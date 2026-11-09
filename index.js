import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsStore, LANGUAGES } from './src/settings.js';
import { capabilities, capabilityWarnings } from './src/capabilities.js';

export const inject = ['tools'];


const obj = (properties = {}, required = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length ? { required } : {}),
  properties,
});

/** Where the restart marker lives between the old and the new app process. */
const dataDir = () => (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-restart')
  : join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'dsh-restart'));

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
const prestartPath = () => join(dataDir(), 'prestart.json');
const overlayPath = () => join(dataDir(), 'overlay.json');
const quarantinePath = () => join(dataDir(), 'quarantine.json');
const safeModePath = () => join(dataDir(), 'safe-mode.json');
const errorsPath = () => join(dataDir(), 'errors.json');
const clientReadyPath = () => join(dataDir(), 'client-ready.json');

/**
 * Every `link:` dependency of the profile with its git state.
 *
 * A dirty working tree is the usual reason a restart breaks: the code that ran
 * before the restart is not the code under test. Recording it lets the recovery
 * script quarantine exactly those packages and preserve their changes in a stash.
 */
const linkPackages = (profileDir) => {
  const out = [];
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  } catch {
    return out;
  }
  const dependencies = pkg?.dependencies ?? {};
  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
    const dir = spec.slice('link:'.length);
    const entry = { name, dir, dirty: false, head: null };
    try {
      const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      entry.dirty = status.trim() !== '';
      const head = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      entry.head = head.trim();
    } catch {
      // Not a repository or git is unavailable: the package is still recorded.
    }
    out.push(entry);
  }
  return out;
};

/** Everything the helper and the recovery script need before the app is killed. */
const writePrestart = ({ profileDir, token, timeoutSeconds, reason = '', plugins = [] }) => {
  writeJson(prestartPath(), {
    token,
    startedAt: new Date().toISOString(),
    timeoutSeconds,
    reason,
    plugins,
    profileDir,
    hashes: profileHashes(profileDir),
    packages: linkPackages(profileDir),
  });
};

const writeJson = (file, value) => {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // A state file that cannot be written must not block the restart.
  }
};

/**
 * Stage profile files to be written while the app is down.
 *
 * Editing `package.json` or `cordis.patch.yml` under a running app makes the
 * loader re-apply the whole tree, which freezes the window until a manual
 * restart. The helper moves these files into place right before it starts the
 * app again, so the change is never seen by a live process.
 */
const stageProfileRestore = ({ bundles } = {}) => {
  const dir = join(dataDir(), 'pending-profile');
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A missing directory is the normal case.
  }
  mkdirSync(dir, { recursive: true });
  const staged = [];
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
    try {
      writeFileSync(join(dir, name), readFileSync(join(backupRoot(), 'last-good', name)));
      staged.push(name);
    } catch {
      // A file that was never snapshotted is simply not staged.
    }
  }
  if (Array.isArray(bundles) && staged.includes('package.json')) {
    try {
      const file = join(dir, 'package.json');
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      pkg.dsh = pkg.dsh ?? {};
      pkg.dsh.profile = pkg.dsh.profile ?? {};
      pkg.dsh.profile.bundles = bundles;
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    } catch {
      // The snapshot stays as it is when the bundle edit cannot be applied.
    }
  }
  return { dir, staged };
};

/** The bundle list of a profile directory. */
const readBundles = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : [];
  } catch {
    return [];
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * A standalone Node binary for the recovery script.
 *
 * `process.execPath` is the desktop executable, not Node: handing it a script
 * path would just start a second copy of the app.
 */
const nodeBinary = () => {
  const candidates = [
    join(process.env.USERPROFILE ?? homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'node.exe';
};

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

const scheduleRestart = async ({ appPid, exe, profileDir, token = '', watchdogEnabled = true, watchdogSeconds = 45, delayMs = 1200, language = 'ru' }) => {
  mkdirSync(dataDir(), { recursive: true });
  const helperPath = join(dataDir(), 'restart-helper.ps1');
  const logPath = join(dataDir(), 'restart.log');
  const taskName = 'DSH-Restart';
  const boot = bootPath();
  const failed = failedPath();
  // History copy of the current (possibly broken) files.
  backupProfile(profileDir, new Date().toISOString().replace(/[:.]/g, '-'));
  const good = join(backupRoot(), 'last-good');
  const backup = existsSync(good) ? good : null;
  const startedAt = new Date().toISOString();
  const timeoutSec = Math.min(180, Math.max(10, Number(watchdogSeconds) || 45));
  // Chromium keeps one auth cookie per launch; stale ones overflow the header
  // limit and break the welcome handshake (HTTP 431).
  const cookieScript = join(dirname(fileURLToPath(import.meta.url)), 'src', 'cookie-clean.py');
  const overlayScript = join(dirname(fileURLToPath(import.meta.url)), 'src', 'overlay.ps1');
  const overlayPython = join(dirname(fileURLToPath(import.meta.url)), 'src', 'overlay.py');
  const caps = capabilities();
  // The window speaks the plugin's language; 'auto' means the app locale, and the
  // watchdog's own default is Russian.
  const overlayLanguage = language === 'ru' || language === 'en' || language === 'zh' ? language : 'ru';
  // One launcher file, so the scheduled task carries a plain path instead of a
  // quoted command line. Tier 1: Tk window; tier 2: PowerShell window; tier 3: a
  // console that tails the log, for a machine without any GUI toolkit.
  const launcherPath = join(dataDir(), process.platform === 'win32' ? 'overlay-launch.cmd' : 'overlay-launch.sh');
  const overlayCommand = (() => {
    if (caps.ui === 'tk' && caps.python !== null) {
      return `${caps.python.binary} "${overlayPython}" --state "${overlayPath()}" --log "${logPath}" --lang ${overlayLanguage}`;
    }
    if (process.platform === 'win32') {
      return `powershell.exe -WindowStyle Hidden -NoProfile -STA -ExecutionPolicy Bypass -File "${overlayScript}" -State "${overlayPath()}" -Log "${logPath}" -Lang ${overlayLanguage}`;
    }
    return `tail -f "${logPath}"`;
  })();
  try {
    mkdirSync(dataDir(), { recursive: true });
    if (process.platform === 'win32') {
      writeFileSync(launcherPath, `@echo off\r\n${overlayCommand}\r\n`, 'utf8');
    } else {
      writeFileSync(launcherPath, `#!/bin/sh\nexec ${overlayCommand}\n`, { mode: 0o755 });
    }
  } catch {
    // The window is optional: the restart itself never depends on it.
  }
  const recoveryScript = join(dirname(fileURLToPath(import.meta.url)), 'src', 'recovery.mjs');
  const overlayFile = overlayPath();
  const startedAtMs = Date.now();

  const quote = (value) => String(value).replace(/'/g, "''");
  const helper = [
    "$ErrorActionPreference = 'Continue'",
    `$log = '${quote(logPath)}'`,
    `$boot = '${quote(boot)}'`,
    `$overlay = '${quote(overlayFile)}'`,
    `$overlayScript = '${quote(overlayScript)}'`,
    `$recovery = '${quote(recoveryScript)}'`,
    `$node = '${quote(nodeBinary())}'`,
    `$profile = '${quote(profileDir)}'`,
    `$exe = '${quote(exe)}'`,
    `$cookies = '${quote(cookieScript)}'`,
    `$launcher = '${quote(launcherPath)}'`,
    `$lang = '${quote(overlayLanguage)}'`,
    `$prestart = '${quote(prestartPath())}'`,
    `$token = '${quote(token)}'`,
    `$timeout = ${timeoutSec}`,
    "function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + ' ' + $m) -Encoding UTF8 }",
    "function Rotate-Log {",
    "  # Old runs mixed UTF-16 and ANSI in one file, which no reader can split.",
    "  # Keep the history as .old and continue in a clean UTF-8 file.",
    "  if (-not (Test-Path -LiteralPath $log)) { return }",
    "  try {",
    "    $bytes = [System.IO.File]::ReadAllBytes($log)",
    "    if ($bytes.Length -lt 2) { return }",
    "    $limit = [Math]::Min(4096, $bytes.Length - 1)",
    "    $zeros = 0",
    "    for ($i = 0; $i -le $limit; $i++) { if ($bytes[$i] -eq 0) { $zeros++ } }",
    "    if ($zeros -gt 0) {",
    "      Move-Item -LiteralPath $log -Destination ($log + '.old') -Force",
    "      New-Item -ItemType File -Path $log -Force | Out-Null",
    "    }",
    "  } catch { }",
    "}",
    "Rotate-Log",
    "function Write-State($phase, $ok, $detail) {",
    "  $reason = ''; $plugins = @()",
    "  if (Test-Path -LiteralPath $prestart) {",
    "    try { $preRaw = Get-Content -LiteralPath $prestart -Raw -Encoding UTF8; $preRaw = $preRaw -replace [string][char]0xFEFF, ''; $pre = $preRaw | ConvertFrom-Json; $reason = [string]$pre.reason; $plugins = @($pre.plugins | Where-Object { $_ }) } catch { }",
    "  }",
    "  $payload = @{ phase = $phase; ok = $ok; detail = $detail; reason = $reason; plugins = $plugins; language = $lang; token = $token; updatedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress",
    "  try { [System.IO.File]::WriteAllText($overlay, $payload, (New-Object System.Text.UTF8Encoding($false))) } catch { }",
    "}",
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
    "function Start-Overlay {",
    "  if (-not (Test-Path -LiteralPath $launcher)) { Log 'overlay launcher missing'; return }",
    "  # A separate task owns the window: Task Scheduler kills the children of the",
    "  # task that ends, and the restart task must come back quicker than a human.",
    "  $action = 'cmd.exe /c \"\"' + $launcher + '\"\"'",
    "  try {",
    "    & \"$env:SystemRoot\\System32\\schtasks.exe\" /Create /F /IT /TN 'DSH-Restart-Overlay' /TR $action /SC ONCE /ST 00:00 2>&1 | ForEach-Object { Log ([string]$_) }",
    "    & \"$env:SystemRoot\\System32\\schtasks.exe\" /Run /TN 'DSH-Restart-Overlay' 2>&1 | ForEach-Object { Log ([string]$_) }",
    "  } catch { Log ('overlay failed: ' + $_) }",
    "}",
    "function Recover($command, $extra) {",
    "  if (-not ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $recovery))) { Log ('recovery unavailable for ' + $command); return $false }",
    "  & $node $recovery $command $extra 2>&1 | ForEach-Object { Log ([string]$_) }",
    "  return $true",
    "}",
    "function Complete($verdict, $mode) {",
    "  Log ('verdict: ' + $verdict)",
    "  Recover ('done ' + $verdict) '' | Out-Null",
    "  $ok = ($verdict -eq 'ok')",
    "  if ($ok) { Write-State 'done' $true 'ok' } else { Write-State 'done' $false $mode }",
    "}",
    "function Wait-Healthy($sinceMs) {",
    "  if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $recovery)) {",
    "    & $node $recovery wait $sinceMs $timeout 2>&1 | ForEach-Object { Log ([string]$_) }",
    "    return ($LASTEXITCODE -eq 0)",
    "  }",
    "  Log 'recovery script unavailable: falling back to the boot marker'",
    "  $since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$sinceMs).UtcDateTime",
    "  $deadline = (Get-Date).ToUniversalTime().AddSeconds($timeout)",
    "  while ((Get-Date).ToUniversalTime() -lt $deadline) {",
    "    if (Test-Path -LiteralPath $boot) {",
    "      try { $b = Get-Content -LiteralPath $boot -Raw | ConvertFrom-Json; if ([datetime]$b.at -gt $since) { return $true } } catch { }",
    "    }",
    "    Start-Sleep -Milliseconds 1500",
    "  }",
    "  return $false",
    "}",
    "function Kill-App { & \"$env:SystemRoot\\System32\\taskkill.exe\" /IM 'DeepSeek Harness.exe' /T /F 2>&1 | ForEach-Object { Log ([string]$_) } }",
    "function Start-App { Recover 'apply-profile' $profile | Out-Null; Start-Process -FilePath $exe; Log 'started' }",
    "Log 'watchdog start'",
    "Write-State 'restart' $false ''",
    "& \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart-Overlay' /F 2>&1 | ForEach-Object { Log ([string]$_) }",
    "Start-Overlay",
    `Start-Sleep -Milliseconds ${delayMs}`,
    `& "$env:SystemRoot\\System32\\taskkill.exe" /PID ${appPid} /T /F 2>&1 | ForEach-Object { Log ([string]$_) }`,
    "Log 'killed'",
    "Start-Sleep -Milliseconds 1500",
    "Purge-Cookies",
    "Start-App",
    "$since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "if (Wait-Healthy $since) { Log 'healthy'; Complete 'ok' ''; Recover 'mark-good' '' | Out-Null; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart' /F 2>&1 | ForEach-Object { Log ([string]$_) }; exit 0 }",
    "if (AuthFailureSince (Get-Date).AddSeconds(-$timeout)) {",
    "  Log 'auth failure detected: purged stale cookies, retrying the start'",
    "  Purge-Cookies",
    "  Start-App",
    "  $since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  if (Wait-Healthy $since) { Log 'healthy after cookie purge'; Complete 'ok' ''; Recover 'mark-good' '' | Out-Null; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart' /F 2>&1 | ForEach-Object { Log ([string]$_) }; exit 0 }",
    "  Log 'still failing after the cookie purge'",
    "}",
    "Log 'boot is not healthy: rolling back and quarantining the suspects'",
    "Write-State 'rollback' $false ''",
    "Recover 'rollback' '' | Out-Null",
    "Kill-App",
    "Start-Sleep -Milliseconds 2000",
    "Start-App",
    "$since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "if (Wait-Healthy $since) { Log 'healthy after rollback'; Complete 'fail' 'recovered'; Recover 'mark-good' '' | Out-Null; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart' /F 2>&1 | ForEach-Object { Log ([string]$_) }; exit 0 }",
    "Log 'still failing: entering safe mode'",
    "Write-State 'safe-mode' $false ''",
    "Recover 'safe' '' | Out-Null",
    "Kill-App",
    "Start-Sleep -Milliseconds 2000",
    "Start-App",
    "$since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "if (Wait-Healthy $since) { Log 'booted in safe mode'; Complete 'fail' 'failed'; & \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart' /F 2>&1 | ForEach-Object { Log ([string]$_) }; exit 0 }",
    "Log 'safe mode did not boot either: giving up'",
    "Complete 'fail' 'failed'",
    "& \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart' /F 2>&1 | ForEach-Object { Log ([string]$_) }",
  ].join('\r\n');
  // Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI, which mangles
  // every Cyrillic literal and breaks the quoting.
  writeFileSync(helperPath, `\uFEFF${helper}`);

  if (process.platform === 'win32' && watchdogEnabled === false) {
    const plain = [
      "$ErrorActionPreference = 'Continue'",
      `$log = '${logPath.replace(/'/g, "''")}'`,
      "Add-Content -LiteralPath $log -Value ('plain restart ' + (Get-Date -Format o))",
      `Start-Sleep -Milliseconds ${delayMs}`,
      `& "$env:SystemRoot\\System32\\taskkill.exe" /PID ${appPid} /T /F 2>&1 | ForEach-Object { Log ([string]$_) }`,
      "Start-Sleep -Milliseconds 1500",
      "$candidate = Join-Path $env:USERPROFILE '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe'",
      "if (Test-Path -LiteralPath $candidate) { $python = $candidate } else { $python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }",
      `$scripts = '${cookieScript.replace(/'/g, "''")}'`,
      "if ($python -and (Test-Path -LiteralPath $scripts)) { & $python $scripts 2>&1 | ForEach-Object { Add-Content -LiteralPath $log -Value ([string]$_) } }",
      `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`,
      "& \"$env:SystemRoot\\System32\\schtasks.exe\" /Delete /TN 'DSH-Restart' /F 2>&1 | ForEach-Object { Log ([string]$_) }",
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

  // POSIX: the same chain as the Windows helper — overlay, kill, start, wait,
  // rollback, safe mode — driven by the shared recovery script, so both
  // platforms decide with one implementation.
  const shHelperPath = join(dataDir(), 'restart-helper.sh');
  const shTemplate = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'src', 'helper.sh'), 'utf8');
  const quoteSh = (value) => String(value).replace(/'/g, "'\\''");
  const shHelper = shTemplate
    .replaceAll('@LOG@', quoteSh(logPath))
    .replaceAll('@NODE@', quoteSh(nodeBinary()))
    .replaceAll('@RECOVERY@', quoteSh(join(dirname(fileURLToPath(import.meta.url)), 'src', 'recovery.mjs')))
    .replaceAll('@LAUNCHER@', quoteSh(launcherPath))
    .replaceAll('@EXE@', quoteSh(exe))
    .replaceAll('@APP_PID@', String(appPid))
    .replaceAll('@TIMEOUT@', String(timeoutSec))
    .replaceAll('@DELAY@', (delayMs / 1000).toFixed(1));
  writeFileSync(shHelperPath, shHelper);
  try {
    execFileSync('chmod', ['+x', shHelperPath]);
  } catch {
    // A filesystem without chmod still runs it through /bin/sh below.
  }
  const launcher = spawn('/bin/sh', [shHelperPath], { detached: true, stdio: 'ignore' });
  launcher.unref();
};

export function apply(ctx, config = {}) {
  const port = config.bridgePort ?? 49233;

  // The profile patch is the deployment default; the form writes overrides.
  const settingsStore = createSettingsStore(dataDir());
  const effective = () => settingsStore.merge({
    language: 'ru',
    toolEnabled: config.toolEnabled !== false,
    watchdogEnabled: config.watchdogEnabled !== false,
    watchdogSeconds: Number.isFinite(config.watchdogSeconds) ? Number(config.watchdogSeconds) : 45,
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

  // Snapshot a manual start as the rollback target; a watchdog start marks the
  // profile good in the helper only after it verified a healthy boot.
  if (!existsSync(prestartPath())) snapshotGood(profileDir);

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
    if (!jobsService || typeof jobsService.start !== 'function' || jobsService.__dshRestartTracked === true) return;
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
    jobsService.__dshRestartTracked = true;
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
      reason: typeof options.reason === 'string' ? options.reason.slice(0, 200) : 'manual',
      note: typeof options.note === 'string' ? options.note.slice(0, 300) : '',
      plugins: Array.isArray(options.plugins) ? options.plugins.filter((name) => typeof name === 'string').slice(0, 8) : [],
    };
    // Only the agent tool resumes the session; a manual restart from the
    // sidebar just brings the app back.
    if (options.continue === false) clearMarker();
    else writeMarker(marker);
    // The watchdog is bound to this restart only: the recovery script compares
    // the profile files with this snapshot and refuses to roll back over manual
    // edits made afterwards.
    const runtime = effective();
    writePrestart({
      profileDir,
      token,
      timeoutSeconds: runtime.watchdogSeconds,
      reason: marker.reason,
      plugins: marker.plugins,
    });
    try {
      await scheduleRestart({ appPid, exe, profileDir, token, ...runtime });
    } catch (error) {
      clearMarker();
      throw error;
    }
    return marker;
  };

  // Diagnostics: did the client bundle actually initialize in this page?
  const seen = { clientLoaded: 0, pendingReads: 0, lastClientAt: null };
  // One page load owns the continuation at a time: a second client asking inside
  // this window gets no marker, which is what stops a doubled message.
  const claimLock = { token: null, at: 0 };
  // A continuation already posted for this session within ten seconds is not
  // repeated: two boots of the same restart must read as one message.
  const lastContinue = new Map();

  const CLAIM_WINDOW_MS = 15_000;

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
          language: 'ru',
          toolEnabled: config.toolEnabled !== false,
          watchdogEnabled: config.watchdogEnabled !== false,
          watchdogSeconds: Number.isFinite(config.watchdogSeconds) ? Number(config.watchdogSeconds) : 45,
        },
        options: LANGUAGES,
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
      // The marker survives the claim: a boot with a broken plugin loads the page
      // but has no composer, so "continue" cannot be submitted there. The retry
      // after the recovery must still find it, and only a successful submit
      // (`/consumed`) retires it. That keeps a double boot from posting twice
      // without losing the message the first time.
      const marker = readMarker();
      let failed = false;
      try {
        failed = existsSync(failedPath());
      } catch {
        failed = false;
      }
      // A recovered boot is still a normal continuation: the watchdog fixed the
      // app and only a plugin is missing. Only an unrecovered one (safe mode)
      // tells the agent that the restart failed.
      let recovered = false;
      if (failed) {
        const report = readJson(failedPath());
        // A restored profile counts as recovered too: nothing was disabled, the
        // configuration was simply put back.
        recovered = report?.safeMode !== true && ((report?.quarantined?.length ?? 0) > 0 || report?.restored === true);
      }
      // A second client inside the window gets nothing: the first one owns the
      // marker until it either submits or releases it.
      let delivered = marker;
      if (delivered !== null && delivered.sessionId && Date.now() - (lastContinue.get(delivered.sessionId) ?? 0) < 10_000) {
        delivered = null;
      }
      // The delivered flag lives in the marker file, so it survives an app
      // restart and a second window: only one client may post the continuation.
      // A failed attempt clears it through /claim/release, which is what keeps
      // the retry after a broken boot working.
      const deliveredAt = marker !== null ? Date.parse(String(marker.deliveredAt ?? '')) : Number.NaN;
      if (delivered !== null && Number.isFinite(deliveredAt) && Date.now() - deliveredAt < 90_000) {
        delivered = null;
      }
      if (marker !== null && claimLock.token === marker.token && Date.now() - claimLock.at < CLAIM_WINDOW_MS) {
        delivered = null;
      } else if (marker !== null) {
        claimLock.token = marker.token;
        claimLock.at = Date.now();
        if (delivered !== null) {
          try {
            writeMarker({ ...marker, deliveredAt: new Date().toISOString() });
          } catch {
            // The in-memory lock still protects this process.
          }
        }
      }
      let queued = false;
      if (delivered?.sessionId) {
        try {
          const agent = ctx.get?.('agents')?.get?.(delivered.sessionId);
          const inbox = agent?.inbox;
          queued = (inbox?.nextTurn?.length ?? 0) + (inbox?.nextStep?.length ?? 0) > 0;
        } catch {
          queued = false;
        }
      }
      send(200, { marker: delivered, queued, failed, recovered, locked: delivered === null && marker !== null });
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
      // The only proof that the renderer really came up: a fresh marker here
      // plus no crash log is what the watchdog calls a healthy boot.
      writeJson(clientReadyPath(), { at: seen.lastClientAt, pid: appPid });
      send(200, { ok: true, seen });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/errors') {
      // Renderer failures reported by the client half: the watchdog quarantines
      // a plugin only when the same one keeps appearing here.
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const items = Array.isArray(parsed?.items) ? parsed.items : [parsed];
          const boot = readJson(bootPath())?.at ?? null;
          const previous = readJson(errorsPath()) ?? { boot, items: [] };
          const merged = [...(previous.items ?? []), ...items
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
              plugin: typeof item.plugin === 'string' ? item.plugin : null,
              message: String(item.message ?? '').slice(0, 500),
              at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
            }))]
            .slice(-200);
          writeJson(errorsPath(), { boot, items: merged });
        } catch {
          // Diagnostics must never break the page.
        }
        send(200, { ok: true });
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/profile/restore') {
      // Restore the profile without touching a running app: the files are
      // staged, the app is restarted, and the helper applies them while it is
      // down. This is the only safe way to edit package.json on a live session.
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const staged = stageProfileRestore(parsed);
          const marker = await request({ sessionId: parsed.sessionId ?? null, reason: 'profile-restore' });
          send(200, { ok: true, staged, marker });
        } catch (error) {
          send(500, { ok: false, error: String(error?.message ?? error) });
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/failed') {
      send(200, {
        failed: readJson(failedPath()),
        quarantine: readJson(quarantinePath()),
        safeMode: readJson(safeModePath()),
        errors: (readJson(errorsPath())?.items ?? []).slice(-20),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/claim/release') {
      // This client could not submit: keep the marker for the retry after the
      // recovery, clear the delivered flag and let another page load claim it.
      claimLock.token = null;
      claimLock.at = 0;
      const current = readMarker();
      if (current !== null) {
        try {
          const rest = { ...current };
          delete rest.deliveredAt;
          writeMarker(rest);
        } catch {
          // A marker that cannot be rewritten keeps the in-memory release.
        }
      }
      send(200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/failed/dismiss') {
      rmSync(failedPath(), { force: true });
      send(200, { ok: true });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/safe-mode/restore' || url.pathname === '/quarantine/restore')) {
      // Restoring never writes the profile under a running app: the bundle list
      // is staged and applied by the helper while the app is down.
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', async () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const safeMode = url.pathname === '/safe-mode/restore';
          const state = readJson(safeMode ? safeModePath() : quarantinePath());
          const names = (safeMode ? state?.removed : (state?.entries ?? []).map((entry) => entry.name)) ?? [];
          const bundles = readBundles(profileDir);
          for (const name of names) {
            if (typeof name === 'string' && !bundles.includes(name)) bundles.push(name);
          }
          stageProfileRestore({ bundles });
          rmSync(safeMode ? safeModePath() : quarantinePath(), { force: true });
          const marker = await request({ sessionId: parsed.sessionId ?? null, reason: safeMode ? 'safe-mode-restore' : 'quarantine-restore' });
          send(200, { ok: true, restored: names.length, marker });
        } catch (error) {
          send(500, { ok: false, error: String(error?.message ?? error) });
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { ok: true, appPid, exe, seen });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/restart' || url.pathname === '/consumed')) {
      if (url.pathname === '/consumed') {
        // Called only after the client actually submitted "continue", or after it
        // decided the message can never be delivered.
        const consumed = readMarker();
        if (consumed?.sessionId) lastContinue.set(consumed.sessionId, Date.now());
        clearMarker();
        rmSync(failedPath(), { force: true });
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
        ctx.logger?.warn?.(`dsh-restart: bridge unavailable: ${error.message}`);
      });
      server.listen(port, '127.0.0.1', () => { listening = true; });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-restart: bridge failed: ${error.message}`);
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
    name: 'dsh_restart_status',
    description: 'Report what dsh_restart checks: permission preset, live sessions, and background jobs.',
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
          watchdog: capabilities(),
          watchdogWarnings: capabilityWarnings(),
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
    name: 'dsh_restart',
    description:
      'Restart the DeepSeek Harness app so plugin or profile changes take effect. '
      + 'Use it only while developing DSH extensions and the user expects a restart — not for ordinary work, not just to refresh state. '
      + 'It kills running jobs and reopens the session with [auto.continue.<token>] (or [auto.continue.failed.<token>] after an unrecovered boot), so a duplicated or lost continuation is traceable; preflight with { fake: true } or dsh_restart_status when unsure.',
    parameters: obj({
      fake: {
        type: 'boolean',
        description: 'Run every preflight check but do not restart the app (for testing the guards)',
      },
      reason: {
        type: 'string',
        description: 'Short reason for the restart, written in the language of the conversation; the watchdog shows it in its window',
      },
      plugins: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extensions being worked on right now (one or more); the watchdog lists them in its window',
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
      const depth = exec?.agent?.options?.subagentDepth;
      if (exec?.parent !== undefined || (typeof depth === 'number' && depth > 0)) {
        throw new Error('dsh_restart is only available to the main agent: a subagent cannot restart the app; do not retry, report the need to the parent agent instead');
      }
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
          `dsh_restart requires the Full access permission preset (current: ${String(preset)}). `
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
          `dsh_restart refused: ${busy.length} other session(s) or subagent(s) are still working `
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
          `dsh_restart refused: ${running.length} background job(s) are still running `
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

      const marker = await request({
        sessionId,
        reason: typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'tool',
        plugins: Array.isArray(args.plugins) ? args.plugins : [],
      });
      return {
        restarted: true,
        ...(marker.sessionId ? { sessionId: marker.sessionId } : {}),
        detail: `Restarting DeepSeek Harness in a moment; this session will be reopened with "[auto.continue]"${sessionId ? ` (${sessionId})` : ''}.`,
      };
    },
  });

  syncTool();

}
