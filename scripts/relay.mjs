#!/usr/bin/env node
/**
 * model-relay control script — the hooks and the /relay command both run this.
 *
 *   relay status                 show mode, threshold, current usage
 *   relay on | off | auto        manual on, manual off, or switch at the threshold
 *   relay threshold <1-100>      percent of plan usage that switches auto mode on
 *   relay window any|5h|7d       which limit the threshold watches (default: any)
 *   relay setup                  install the status line (wraps an existing one)
 *   relay uninstall              restore the previous status line
 *
 *   relay hook-prompt            UserPromptSubmit hook
 *   relay hook-session           SessionStart hook
 *
 * Hooks print nothing while relay is inactive, so it costs zero tokens until
 * it is needed. Zero dependencies.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = path.join(homedir(), '.claude');
const DIR = path.join(HOME, 'model-relay');
const SETTINGS = path.join(HOME, 'settings.json');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATUSLINE = path.join(DIR, 'statusline.mjs');
const OUR_COMMAND = `node "${STATUSLINE.replace(/\\/g, '/')}"`;

const HOUR = 3_600_000;
const DEFAULTS = { mode: 'auto', threshold: 50, window: 'any', wrap: null };

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

const loadConfig = () => ({ ...DEFAULTS, ...readJson(path.join(DIR, 'config.json'), {}) });
const saveConfig = (cfg) => writeJson(path.join(DIR, 'config.json'), cfg);

/** Usage as last seen by the status line, dropping numbers too old to trust. */
function loadUsage() {
  const u = readJson(path.join(DIR, 'usage.json'), {});
  const age = Date.now() - (u.at ?? 0);
  return {
    five_hour: age < 5 * HOUR ? u.five_hour ?? null : null,
    seven_day: age < 7 * 24 * HOUR ? u.seven_day ?? null : null,
    seen: Boolean(u.at),
  };
}

function evaluate(cfg = loadConfig(), usage = loadUsage()) {
  if (cfg.mode === 'on') return { active: true, reason: 'turned on manually' };
  if (cfg.mode === 'off') return { active: false, reason: 'turned off manually' };

  const watched = [
    cfg.window !== 'seven_day' && ['5-hour limit', usage.five_hour],
    cfg.window !== 'five_hour' && ['weekly limit', usage.seven_day],
  ].filter((w) => w && w[1] != null);

  const hit = watched.find(([, pct]) => pct >= cfg.threshold);
  if (hit) return { active: true, reason: `${hit[0]} at ${hit[1]}% ≥ ${cfg.threshold}%` };
  const peak = watched.length ? Math.max(...watched.map(([, p]) => p)) : null;
  return {
    active: false,
    reason: peak == null ? 'no usage data yet' : `usage ${peak}% < ${cfg.threshold}%`,
  };
}

/* ----------------------------------------------------------------- hooks */

const ACTIVE_RULES =
  'Save Claude plan usage by spending other models instead: use the ' +
  'model-subagents skill and delegate every self-contained piece of work (drafting ' +
  'code or text, summaries, reviews, research questions, bulk analysis) to the ' +
  'model-router tools, picking model + effort per task (low for bulk, high only for ' +
  'hard reasoning). Do directly only what needs tools, this repo or this ' +
  'conversation, verify delegated output before using it, and keep your own replies short.';

function hookPrompt() {
  const now = evaluate();
  const flagFile = path.join(DIR, 'active.json');
  const was = readJson(flagFile, { active: false }).active;
  if (now.active !== was) writeJson(flagFile, { active: now.active, at: Date.now() });

  if (now.active) {
    const first = was ? '' : ' Relay mode just switched on: tell the user so in one short line, with the reason.';
    process.stdout.write(`[model-relay ACTIVE — ${now.reason}] ${ACTIVE_RULES}${first}\n`);
  } else if (was) {
    process.stdout.write(
      `[model-relay] Relay mode is now off (${now.reason}). Work normally again; mention it in one short line.\n`
    );
  }
}

function hookSession() {
  const settings = readJson(SETTINGS, {});
  const current = settings.statusLine?.command;
  if (current === OUR_COMMAND) {
    copyFileSync(path.join(HERE, 'statusline.mjs'), STATUSLINE); // keep it current across updates
    return;
  }
  if (!current) {
    setup({ quiet: true });
    return;
  }
  // Someone else's status line: never replace it silently.
  process.stdout.write(
    '[model-relay] Automatic relay needs the model-relay status line (it is the only source of plan usage), ' +
      'but another status line is configured. Tell the user once: run `/model-relay:relay setup` to wrap it — ' +
      'their existing line keeps working.\n'
  );
}

/* --------------------------------------------------------------- commands */

function setup({ quiet = false } = {}) {
  mkdirSync(DIR, { recursive: true });
  copyFileSync(path.join(HERE, 'statusline.mjs'), STATUSLINE);

  const settings = readJson(SETTINGS, {});
  const cfg = loadConfig();
  const current = settings.statusLine?.command;
  if (current && current !== OUR_COMMAND) cfg.wrap = current;
  saveConfig(cfg);

  settings.statusLine = { type: 'command', command: OUR_COMMAND };
  writeJson(SETTINGS, settings);

  if (!quiet) {
    console.log('Status line installed.' + (cfg.wrap ? ` Your previous one still runs: ${cfg.wrap}` : ''));
    console.log('Usage numbers appear after the next reply.');
  }
}

function uninstall() {
  const settings = readJson(SETTINGS, {});
  const cfg = loadConfig();
  if (settings.statusLine?.command === OUR_COMMAND) {
    if (cfg.wrap) settings.statusLine = { type: 'command', command: cfg.wrap };
    else delete settings.statusLine;
    writeJson(SETTINGS, settings);
  }
  cfg.wrap = null;
  saveConfig(cfg);
  console.log('Status line removed' + (settings.statusLine ? ' and the previous one restored.' : '.'));
}

function status() {
  const cfg = loadConfig();
  const usage = loadUsage();
  const now = evaluate(cfg, usage);
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const bar = (v) => (v == null ? '' : ' ' + '█'.repeat(Math.round(v / 5)) + '░'.repeat(20 - Math.round(v / 5)));
  const statusOk = readJson(SETTINGS, {}).statusLine?.command === OUR_COMMAND;

  console.log(`Relay:      ${now.active ? 'ON  ⇄' : 'off'}   (${now.reason})`);
  console.log(`Mode:       ${cfg.mode}${cfg.mode === 'auto' ? `  — switches on at ${cfg.threshold}% (${cfg.window})` : ''}`);
  console.log(`5-hour:     ${pct(usage.five_hour).padStart(4)}${bar(usage.five_hour)}`);
  console.log(`Weekly:     ${pct(usage.seven_day).padStart(4)}${bar(usage.seven_day)}`);
  console.log(`Statusline: ${statusOk ? 'installed' : 'NOT installed — run `relay setup` (auto mode needs it)'}`);
  if (statusOk && !usage.seen) console.log('            no usage seen yet — it arrives after the next reply.');
}

const [cmd = 'status', arg] = process.argv.slice(2).map((s) => s.toLowerCase());
const cfg = loadConfig();

switch (cmd) {
  case 'hook-prompt':
    hookPrompt();
    break;
  case 'hook-session':
    hookSession();
    break;
  case 'on':
  case 'off':
  case 'auto':
    saveConfig({ ...cfg, mode: cmd });
    status();
    break;
  case 'threshold': {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      console.log('Usage: relay threshold <1-100>');
      process.exit(1);
    }
    saveConfig({ ...cfg, threshold: n });
    status();
    break;
  }
  case 'window': {
    const w = { any: 'any', '5h': 'five_hour', '7d': 'seven_day' }[arg];
    if (!w) {
      console.log('Usage: relay window any|5h|7d');
      process.exit(1);
    }
    saveConfig({ ...cfg, window: w });
    status();
    break;
  }
  case 'setup':
    setup();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    status();
    break;
  default:
    console.log('Usage: relay [status | on | off | auto | threshold <n> | window any|5h|7d | setup | uninstall]');
    process.exit(1);
}
