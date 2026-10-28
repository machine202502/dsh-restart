import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Operator overrides for the restart plugin.
 *
 * The profile patch stays the deployment default; this file holds what the
 * settings form saves, so a form write never edits cordis.patch.yml by hand.
 */
const KEYS = {
  toolEnabled: 'boolean',
  watchdogEnabled: 'boolean',
  watchdogSeconds: 'number',
};

const bounded = (value, min, max) => Math.min(max, Math.max(min, value));

export function sanitizeSettings(input = {}) {
  const out = {};
  for (const [key, kind] of Object.entries(KEYS)) {
    const value = input?.[key];
    if (kind === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    const number = Number(value);
    if (Number.isFinite(number)) out[key] = bounded(Math.round(number), 1, 120);
  }
  return out;
}

export function createSettingsStore(dataDir) {
  const file = join(dataDir, 'settings.json');
  const read = () => {
    try {
      return existsSync(file) ? sanitizeSettings(JSON.parse(readFileSync(file, 'utf8'))) : {};
    } catch {
      return {};
    }
  };
  const write = (input) => {
    const overrides = sanitizeSettings({ ...read(), ...input });
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify(overrides, null, 2));
    } catch {
      // A failed write keeps the previous overrides.
    }
    return overrides;
  };
  const merge = (defaults) => ({ ...defaults, ...read() });
  return { file, read, write, merge };
}
