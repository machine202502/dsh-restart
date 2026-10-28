import { apply } from '../index.js';

const tools = new Map();
const disposers = [];
const services = {};
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  get: (name) => services[name],
  logger: { warn: (message) => console.warn(message) },
};

apply(ctx, { bridgePort: 49234 });

const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);

check('tool registered', tools.has('hsb_restart'), [...tools.keys()].join(', '));
const schema = tools.get('hsb_restart')?.parameters;
check('only fake is tunable', Object.keys(schema?.properties ?? {}).join(',') === 'fake', JSON.stringify(schema?.properties ?? {}));

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

// The tool must refuse to restart while anything else is working.
const tool = tools.get('hsb_restart');
const self = { id: 's-self', session: {}, status: 'running', inbox: { nextTurn: [], nextStep: [] } };

services.permissionPresets = { current: () => 'auto' };
let denial = null;
try { await tool.execute({}, { agent: self }); } catch (error) { denial = error.message; }
check('refuses without Full access', Boolean(denial && /Full access/.test(denial)), denial ?? 'no error');

services.permissionPresets = { current: () => 'danger-full-access' };
services.agents = { list: () => [self, { id: 's-other', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] };
denial = null;
try { await tool.execute({}, { agent: self }); } catch (error) { denial = error.message; }
check('refuses while another session works', Boolean(denial && /other session/.test(denial)), denial ?? 'no error');

services.agents = { list: () => [self] };
services.jobs = { list: () => [{ id: 'job-1', status: 'running' }] };
denial = null;
try { await tool.execute({}, { agent: self }); } catch (error) { denial = error.message; }
check('refuses while a background job runs', Boolean(denial && /background job/.test(denial)), denial ?? 'no error');

services.agents = { list: () => [self] };
services.jobs = { list: () => [] };
const fake = await tool.execute({ fake: true }, { agent: self });
check('fake restart skips the restart', fake.restarted === false && /fake restart/.test(fake.detail), fake.detail);
const afterFake = await fetch(`${base}/pending`).then((response) => response.json());
check('fake leaves no marker', afterFake.pending === null);

for (const dispose of disposers) dispose();
process.exit(0);
