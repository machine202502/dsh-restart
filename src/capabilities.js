import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What the watchdog can use on this machine.
 *
 * The recovery core is pure Node and always works. Only the visible window has
 * optional dependencies, so the probe answers one question: which UI tier can we
 * show — a Tk window, a thin PowerShell window, a console tail, or nothing.
 */

const candidates = () => {
  const list = [];
  if (process.platform === 'win32') {
    list.push(join(process.env.USERPROFILE ?? homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'));
    list.push('python.exe');
  } else {
    list.push(join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'));
    list.push('python3');
    list.push('python');
  }
  return list;
};

const probe = (binary) => {
  if (binary.includes(':') || binary.includes('\\') || binary.includes('/')) {
    if (!existsSync(binary)) return null;
  }
  try {
    const result = spawnSync(binary, ['-c', 'import sys, tkinter; print(sys.version.split()[0])'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() !== '') {
      return { binary, version: result.stdout.trim(), tkinter: true };
    }
    // Python is there but tkinter is not: still useful for cookie cleanup.
    const plain = spawnSync(binary, ['-c', 'import sys; print(sys.version.split()[0])'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (plain.status === 0) return { binary, version: String(plain.stdout ?? '').trim(), tkinter: false };
    return null;
  } catch {
    return null;
  }
};

/** Display availability: a Linux box without X11/Wayland cannot show Tk at all. */
const hasDisplay = () => {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
};

let cached = null;

/**
 * @returns {{ python: {binary: string, version: string, tkinter: boolean}|null,
 *   display: boolean, ui: 'tk'|'powershell'|'console'|'none', platform: string }}
 */
export const capabilities = () => {
  if (cached !== null) return cached;
  let python = null;
  for (const candidate of candidates()) {
    python = probe(candidate);
    if (python !== null) break;
  }
  const display = hasDisplay();
  let ui = 'console';
  if (python?.tkinter === true && display) ui = 'tk';
  else if (process.platform === 'win32') ui = 'powershell';
  else if (!display) ui = 'console';
  else ui = 'console';
  cached = { python, display, ui, platform: process.platform };
  return cached;
};

/** Human-readable warnings for the restart preflight. */
export const capabilityWarnings = () => {
  const info = capabilities();
  const warnings = [];
  if (info.ui === 'powershell') warnings.push('Tk window unavailable: the watchdog falls back to a thin PowerShell window.');
  if (info.ui === 'console') warnings.push('No graphical window available: the watchdog will show progress in a console tail.');
  if (info.python === null) warnings.push('Python is missing: cookie cleanup is skipped and the Tk window is unavailable.');
  else if (!info.python.tkinter) warnings.push('Python has no tkinter: the watchdog uses the console/PowerShell window.');
  if (!info.display) warnings.push('No display detected: only a console window can be shown.');
  return warnings;
};
