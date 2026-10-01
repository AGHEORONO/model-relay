import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULTS = { file: path.join(homedir(), '.jot', 'notes.json'), pageSize: 20, dateFormat: 'iso', color: true };

/** ~/.jotrc (JSON) overrides defaults; JOT_FILE and NO_COLOR override both. */
export function loadConfig() {
  let rc = {};
  try {
    rc = JSON.parse(readFileSync(path.join(homedir(), '.jotrc'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`~/.jotrc is not valid JSON: ${e.message}`);
  }
  const cfg = { ...DEFAULTS, ...rc };
  if (process.env.JOT_FILE) cfg.file = process.env.JOT_FILE;
  if (process.env.NO_COLOR) cfg.color = false;
  if (!['iso', 'relative'].includes(cfg.dateFormat)) throw new Error(`dateFormat must be "iso" or "relative"`);
  return cfg;
}
