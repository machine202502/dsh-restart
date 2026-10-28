import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const scheduleRestart = async ({ appPid, exe, delayMs = 1500 }) => {
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

  /**
   * Fallback for jobs whose registry record is gone: DSH runs background work as
   * shell children of this Host process, so a live child shell means a live job.
   */
  const childShells = () => {
    if (process.platform !== 'win32') return [];
    const query = [
      'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\' OR Name=\'pwsh.exe\' OR Name=\'cmd.exe\'"',
      `| Where-Object { $_.ParentProcessId -eq ${process.pid} }`,
      '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ].join(' ');
    try {
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', query], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      // Ignore the inspector itself.
      return rows.filter((row) => !String(row?.CommandLine ?? '').includes('Get-CimInstance'));
    } catch {
      return [];
    }
  };

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
    const marker = {
      // A restart always resumes the session: the chat gets "continue".
      continue: true,
      sessionId: typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null,
      at: new Date().toISOString(),
      reason: options.reason ?? 'manual',
    };
    writeMarker(marker);
    try {
      await scheduleRestart({ appPid, exe });
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

    if (req.method === 'GET' && url.pathname === '/claim') {
      // Atomic: only one page load may consume the restart marker, so a double
      // boot cannot post the auto message twice.
      const marker = readMarker();
      if (marker) clearMarker();
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
      send(200, { marker, queued });
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
          const marker = await request({ sessionId: parsed.sessionId, reason: 'ui' });
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

  ctx.tools.register({
    name: 'hsb_restart',
    description:
      'Restart the DeepSeek Harness desktop app. Use it after changing plugin code or profile configuration that only takes effect on a fresh start. '
      + 'Set continue to true to reopen this session and send "continue" after the restart, so the work resumes without a manual message.',
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
      if (running.length === 0) {
        try {
          for (const child of childShells()) {
            collect({ id: String(child.ProcessId), status: 'running', label: String(child.CommandLine ?? '') });
          }
        } catch {
          // Process inspection is best effort too.
        }
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

}
