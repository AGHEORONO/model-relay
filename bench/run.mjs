#!/usr/bin/env node
/**
 * Measure what relay actually saves, with real Claude Code runs.
 *
 *   node bench/run.mjs --dry                     check the harness (no Claude calls)
 *   node bench/run.mjs                           every task, relay off and on
 *   node bench/run.mjs --tasks code-module --modes on --model sonnet
 *
 * Each task runs in a fresh copy of its fixture through `claude -p
 * --output-format json`, once with relay off and once with relay on. Claude
 * Code reports the real token usage and list-price cost of each run; a
 * per-task check.mjs decides whether the result is actually correct. Savings
 * only count when both runs pass.
 *
 * This spends real Claude plan usage (roughly $1-5 of list-price usage per
 * run) plus quota on the delegate CLIs.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'scripts', 'relay.mjs');
const STATE = path.join(homedir(), '.claude', 'model-relay');
const LEDGER = path.join(STATE, 'ledger.jsonl');
const CONFIG = path.join(STATE, 'config.json');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DRY = argv.includes('--dry');
const allTasks = readdirSync(path.join(HERE, 'tasks')).filter((t) => existsSync(path.join(HERE, 'tasks', t, 'task.json')));
const tasks = opt('tasks', allTasks.join(',')).split(',');
const modes = opt('modes', 'off,on').split(',');
const model = opt('model', null);

const check = (task, ws) => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'tasks', task, 'check.mjs'), ws], { encoding: 'utf8' });
  const line = (r.stdout || r.stderr).trim().split('\n').pop();
  return { pass: r.status === 0, message: line };
};

const ledgerLines = () => {
  try {
    return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

function setRelay(mode) {
  spawnSync(process.execPath, [RELAY, mode], { encoding: 'utf8' });
}

function runClaude(prompt, cwd, timeoutSec) {
  const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ is_error: true, result: `exit ${code}: ${(err || out).slice(0, 400)}` });
      }
    });
  });
}

async function runOne(task, mode) {
  const spec = JSON.parse(readFileSync(path.join(HERE, 'tasks', task, 'task.json'), 'utf8'));
  const ws = mkdtempSync(path.join(tmpdir(), `relay-bench-${task}-${mode}-`));
  cpSync(path.join(HERE, 'tasks', task, 'fixture'), ws, { recursive: true });

  if (DRY) return { task, mode, category: spec.category, ws, ...check(task, ws), dry: true };

  setRelay(mode);
  const before = ledgerLines().length;
  const started = Date.now();
  const out = await runClaude(spec.prompt, ws, spec.timeoutSec ?? 900);
  const calls = ledgerLines().slice(before).map((l) => JSON.parse(l));
  const u = out.usage ?? {};
  return {
    task,
    category: spec.category,
    mode,
    ws,
    ...check(task, ws),
    error: out.is_error ? String(out.result).slice(0, 300) : null,
    costUSD: out.total_cost_usd ?? null,
    outputTokens: u.output_tokens ?? null,
    inputTokens: u.input_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? null,
    turns: out.num_turns ?? null,
    seconds: Math.round((Date.now() - started) / 1000),
    delegated: {
      calls: calls.length,
      ok: calls.filter((c) => c.ok).length,
      toFile: calls.filter((c) => c.to_file).length,
      models: [...new Set(calls.map((c) => c.model))],
    },
  };
}

function report(results, stamp) {
  const pct = (a, b) => (a != null && b ? `${Math.round(100 * (1 - a / b))}%` : '—');
  const $ = (v) => (v == null ? '—' : `$${v.toFixed(2)}`);
  const k = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
  const lines = [
    `# Relay benchmark — ${stamp}`,
    '',
    `Model: ${model ?? 'Claude Code default'} · cost = Claude Code's list-price \`total_cost_usd\` for the whole run.`,
    '',
    '| Task | Category | Relay | Result | Cost | Output tok | Turns | Delegated calls | Time |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.task} | ${r.category} | ${r.mode} | ${r.pass ? '✅' : '❌'} ${r.message ?? ''} | ${$(r.costUSD)} | ${k(r.outputTokens)} | ${r.turns ?? '—'} | ${r.delegated?.calls ?? 0}${r.delegated?.models?.length ? ` (${r.delegated.models.join(', ')})` : ''} | ${r.seconds ?? '—'}s |`
    );
  }
  lines.push('', '## Savings (relay on vs off)', '', '| Task | Cost off → on | Cost saved | Output tokens saved | Both passed |', '|---|---|---|---|---|');
  let offSum = 0;
  let onSum = 0;
  for (const task of [...new Set(results.map((r) => r.task))]) {
    const off = results.find((r) => r.task === task && r.mode === 'off');
    const on = results.find((r) => r.task === task && r.mode === 'on');
    if (!off || !on) continue;
    const both = off.pass && on.pass;
    if (both) {
      offSum += off.costUSD ?? 0;
      onSum += on.costUSD ?? 0;
    }
    lines.push(`| ${task} | ${$(off.costUSD)} → ${$(on.costUSD)} | ${pct(on.costUSD, off.costUSD)} | ${pct(on.outputTokens, off.outputTokens)} | ${both ? 'yes' : 'no — not counted'} |`);
  }
  if (offSum) lines.push('', `**Total over tasks where both runs passed: ${$(offSum)} → ${$(onSum)} (${pct(onSum, offSum)} saved).**`);
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ main */

const originalConfig = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : null;
const restore = () => {
  if (DRY) return;
  if (originalConfig != null) writeFileSync(CONFIG, originalConfig);
};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(HERE, 'results');
mkdirSync(outDir, { recursive: true });
const results = [];
try {
  for (const [i, task] of tasks.entries()) {
    // Alternate the order so neither mode always gets the warmer prompt cache.
    const order = i % 2 ? [...modes].reverse() : modes;
    for (const mode of order) {
      process.stdout.write(`${task} [relay ${mode}] … `);
      const r = await runOne(task, mode);
      results.push(r);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}${r.costUSD != null ? ` $${r.costUSD.toFixed(2)}` : ''}${r.delegated ? ` · ${r.delegated.calls} delegated` : ''}${r.error ? ` · ${r.error}` : ''}`);
      if (!DRY) writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(results, null, 2));
    }
  }
} finally {
  restore();
}

if (DRY) {
  const bad = results.filter((r) => r.pass);
  console.log(bad.length ? `\nHarness problem: these checks pass on the untouched fixture: ${bad.map((r) => r.task).join(', ')}` : '\nHarness OK: every check fails on its untouched fixture.');
  process.exit(bad.length ? 1 : 0);
}
writeFileSync(path.join(outDir, `${stamp}.md`), report(results, stamp));
console.log(`\nReport: bench/results/${stamp}.md`);
