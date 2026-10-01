#!/usr/bin/env node
/**
 * model-relay status line.
 *
 * Claude Code pipes session JSON to the status line on every update, and it is
 * the only place that JSON carries plan usage (rate_limits). So this script
 * does two jobs: save the usage numbers for the relay hook, and draw a line.
 *
 * If you already had a status line, `relay setup` stored it as `wrap` and it
 * keeps running — our segment is appended to its output.
 *
 * Copied to ~/.claude/model-relay/ by `relay setup`, so the path in
 * settings.json survives plugin updates. Zero dependencies, must stay fast.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DIR = path.join(homedir(), '.claude', 'model-relay');
const readJson = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(path.join(DIR, f), 'utf8'));
  } catch {
    return fallback;
  }
};

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    /* draw what we can */
  }

  const five = input.rate_limits?.five_hour?.used_percentage;
  const week = input.rate_limits?.seven_day?.used_percentage;
  if (five != null || week != null) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      path.join(DIR, 'usage.json'),
      JSON.stringify({ five_hour: five ?? null, seven_day: week ?? null, at: Date.now() })
    );
  }

  const cfg = { mode: 'auto', threshold: 50, window: 'any', ...readJson('config.json', {}) };
  const peak = cfg.window === 'five_hour' ? five : cfg.window === 'seven_day' ? week : Math.max(five ?? 0, week ?? 0);
  const active = cfg.mode === 'on' || (cfg.mode === 'auto' && peak >= cfg.threshold);

  const relay = active
    ? `⇄ RELAY ON${cfg.mode === 'on' ? ' (manual)' : ''}`
    : cfg.mode === 'off'
      ? 'relay off'
      : `relay auto @${cfg.threshold}%`;
  const usage = [five != null && `5h ${five}%`, week != null && `7d ${week}%`].filter(Boolean).join(' · ');
  const segment = [usage, relay].filter(Boolean).join(' · ');

  let base = '';
  if (cfg.wrap) {
    try {
      base = execSync(cfg.wrap, { input: raw, encoding: 'utf8', timeout: 2000, windowsHide: true }).trimEnd();
    } catch {
      /* a broken wrapped line must not hide ours */
    }
  } else {
    const model = input.model?.display_name ?? '';
    const ctx = input.context_window?.used_percentage;
    base = [model, ctx != null && `ctx ${ctx}%`].filter(Boolean).join(' · ');
  }

  process.stdout.write([base, segment].filter(Boolean).join('  │  ') + '\n');
});
