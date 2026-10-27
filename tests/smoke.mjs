import { apply } from '../index.js';

const tools = new Map();
const disposers = [];
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  logger: { warn: (message) => console.warn(message) },
};

apply(ctx, { bridgePort: 49234 });

const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);

check('tool registered', tools.has('hsb_restart'), [...tools.keys()].join(', '));
const schema = tools.get('hsb_restart')?.parameters;
check('continue is optional boolean', schema?.properties?.continue?.type === 'boolean' && !schema?.required, JSON.stringify(schema?.required ?? []));

// The bridge starts on the next tick so plugin activation never waits for it.
await new Promise((resolve) => setTimeout(resolve, 100));
const base = 'http://127.0.0.1:49234';
const health = await fetch(`${base}/health`).then((response) => response.json());
check('bridge listens', health.ok === true, `appPid ${health.appPid}`);

await fetch(`${base}/consumed`, { method: 'POST', body: '{}' });
const pending = await fetch(`${base}/pending`).then((response) => response.json());
check('no marker yet', pending.pending === null);

const consumed = await fetch(`${base}/consumed`, { method: 'POST', body: '{}' });
check('consumed endpoint', consumed.ok, String(consumed.status));

for (const dispose of disposers) dispose();
process.exit(0);
