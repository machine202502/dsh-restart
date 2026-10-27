import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * Restart the desktop app from an independent process.
 *
 * A child of the app dies with the `taskkill /T` tree it launches, so the
 * helper is registered as a one-shot scheduled task instead: Task Scheduler
 * owns it, it survives the shutdown, and it deletes the task afterwards.
 */
const scheduleRestart = ({ appPid, exe, delayMs = 1500 }) => {
  mkdirSync(dataDir(), { recursive: true });
  const helperPath = join(dataDir(), 'restart-helper.ps1');
  const logPath = join(dataDir(), 'restart.log');
  const taskName = 'HSB-Restart';

  const helper = [
    "$ErrorActionPreference = 'Continue'",
    `Add-Content -LiteralPath '${logPath}' -Value ('helper start ' + (Get-Date -Format o))`,
    `Start-Sleep -Milliseconds ${delayMs}`,
    `& "$env:SystemRoot\\System32\\taskkill.exe" /PID ${appPid} /T /F *>> '${logPath}'`,
    `Add-Content -LiteralPath '${logPath}' -Value ('killed ' + (Get-Date -Format o))`,
    'Start-Sleep -Milliseconds 1800',
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`,
    `Add-Content -LiteralPath '${logPath}' -Value ('started ' + (Get-Date -Format o))`,
    `& "$env:SystemRoot\\System32\\schtasks.exe" /Delete /TN '${taskName}' /F *>> '${logPath}'`,
  ].join('\r\n');
  writeFileSync(helperPath, helper);

  if (process.platform === 'win32') {
    const command = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${helperPath}"`;
    const create = spawn('schtasks.exe', [
      '/Create', '/F', '/IT', '/TN', taskName, '/TR', command, '/SC', 'ONCE', '/ST', '00:00',
    ], { stdio: 'ignore', windowsHide: true });
    create.on('exit', (code) => {
      spawn('schtasks.exe', ['/Run', '/TN', taskName], { stdio: 'ignore', windowsHide: true });
    });
    return;
  }

  const open = process.platform === 'darwin' ? `open -a "${exe}"` : `"${exe}" >/dev/null 2>&1 &`;
  const script = `sleep ${(delayMs / 1000).toFixed(1)}; kill -TERM ${appPid} 2>/dev/null; sleep 1; ${open}`;
  const launcher = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
  launcher.unref();
};

export function apply(ctx, config = {}) {
  const port = config.bridgePort ?? 49233;
  const exe = process.execPath;
  const appPid = process.ppid;

  const request = (options) => {
    const marker = {
      continue: options.continue === true,
      sessionId: typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null,
      at: new Date().toISOString(),
      reason: options.reason ?? 'manual',
    };
    writeMarker(marker);
    scheduleRestart({ appPid, exe });
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
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          send(400, { ok: false, error: 'invalid json' });
          return;
        }
        const marker = request({ continue: parsed.continue === true, sessionId: parsed.sessionId, reason: 'ui' });
        send(200, { ok: true, marker });
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
    name: 'hsb_restart',
    description:
      'Restart the DeepSeek Harness desktop app. Use it after changing plugin code or profile configuration that only takes effect on a fresh start. '
      + 'Set continue to true to reopen this session and send "continue" after the restart, so the work resumes without a manual message.',
    parameters: obj({
      continue: {
        type: 'boolean',
        description: 'After the restart, reopen this session and send the text "continue" to resume the work (default false)',
      },
    }),
    output: {
      schema: obj({
        restarted: { type: 'boolean' },
        continue: { type: 'boolean' },
        sessionId: { type: 'string' },
        detail: { type: 'string' },
      }, ['restarted']),
      render: (_args, value) => [{ type: 'text', text: value.detail ?? 'restarting DeepSeek Harness' }],
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id ?? null;
      const marker = request({ continue: args.continue === true, sessionId, reason: 'tool' });
      return {
        restarted: true,
        continue: marker.continue,
        ...(marker.sessionId ? { sessionId: marker.sessionId } : {}),
        detail: marker.continue
          ? `Restarting DeepSeek Harness in a moment; this session will be reopened with "continue"${sessionId ? ` (${sessionId})` : ''}.`
          : 'Restarting DeepSeek Harness in a moment.',
      };
    },
  });

}
