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
 *   relay stats [days]           what delegation saved (from the call ledger)
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

/**
 * Estimated savings, in Claude output-token equivalents.
 *
 * Plan usage is driven mostly by output tokens; input costs ~1/5 as much
 * (the API price ratio), so input is converted at 1/5. Per call:
 *   with relay  = Claude writes the prompt (out) + reads the reply (in)
 *   without     = Claude writes the reply itself (out) + reads the files (in)
 * Assumes Claude's own answer would be about as long as the delegate's, and
 * ignores any extra reading Claude does to verify — so treat it as an estimate.
 */
function stats(days) {
  const OUT_PER_IN = 5;
  const tok = (chars) => chars / 4;
  const since = days ? Date.now() - days * 24 * HOUR : 0;
  let lines = [];
  try {
    lines = readFileSync(path.join(DIR, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
  } catch {
    /* no ledger yet */
  }
  const calls = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((c) => c && c.at >= since);

  const window = days ? `last ${days} day${days === 1 ? '' : 's'}` : 'all time';
  if (!calls.length) {
    console.log(`No delegated calls recorded (${window}).`);
    return;
  }

  const byModel = new Map();
  const total = { n: 0, ok: 0, claude: 0, files: 0, reply: 0, ms: 0, saved: 0, baseline: 0 };
  const toFile = calls.filter((c) => c.ok && c.to_file).length;
  for (const c of calls) {
    const withRelay = tok(c.claude_chars) + tok(c.reply_chars) / OUT_PER_IN;
    const without = c.ok ? tok(c.reply_chars) + tok(c.file_chars) / OUT_PER_IN : 0;
    const saved = c.ok ? without - withRelay : -withRelay;
    for (const t of [total, byModel.get(c.model) ?? byModel.set(c.model, { n: 0, ok: 0, claude: 0, files: 0, reply: 0, ms: 0, saved: 0, baseline: 0 }).get(c.model)]) {
      t.n++; t.ok += c.ok ? 1 : 0; t.claude += c.claude_chars; t.files += c.file_chars;
      t.reply += c.reply_chars; t.ms += c.ms; t.saved += saved; t.baseline += without;
    }
  }

  const k = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);
  const pct = total.baseline > 0 ? Math.round((100 * total.saved) / total.baseline) : 0;
  console.log(`Delegated calls (${window}): ${total.n}  ·  ok ${total.ok}  ·  avg ${(total.ms / total.n / 1000).toFixed(1)}s`);
  console.log(`Claude wrote:       ~${k(tok(total.claude))} tokens of prompts`);
  console.log(`Server attached:    ~${k(tok(total.files))} tokens of files (Claude never wrote or read them)`);
  console.log(`Other models wrote: ~${k(tok(total.reply))} tokens of answers  (${toFile} of ${total.ok} written straight to disk)`);
  console.log(`Estimated saving:   ~${k(total.saved)} Claude output-token equivalents  (${pct}% of what these tasks would have cost Claude)`);
  console.log('');
  console.log('By model:');
  for (const [m, t] of [...byModel].sort((a, b) => b[1].saved - a[1].saved)) {
    console.log(`  ${m.padEnd(46)} ${String(t.n).padStart(4)} calls  ~${k(t.saved).padStart(6)} saved`);
  }
  console.log('');
  console.log('Estimate: input counted at 1/5 of output; assumes Claude would have written an answer');
  console.log("as long as the delegate's; excludes Claude's own reading to verify results. An inline answer");
  console.log('that Claude then re-typed into a file saved nothing — use output_file for those.');
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
  case 'stats':
    stats(arg ? Number(arg) : 0);
    break;
  default:
    console.log('Usage: relay [status | on | off | auto | threshold <n> | window any|5h|7d | stats [days] | setup | uninstall]');
    process.exit(1);
}
