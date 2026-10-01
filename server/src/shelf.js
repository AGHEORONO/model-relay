#!/usr/bin/env node
/**
 * Draw every backend and its models as books on a shelf, in plain text.
 *
 *   node src/shelf.js            # every backend, first 2 rows of books each
 *   node src/shelf.js all        # every book
 *   node src/shelf.js cursor     # one backend, every book
 *
 * Model ids that differ only by effort / thinking / fast suffix are stacked
 * into one book ("gpt-5.5-low", "gpt-5.5-high-fast" -> book "gpt-5.5").
 * No colour: the output is meant to be pasted into a code block.
 */

import { loadProviders } from './providers.js';
import { listModels } from './client.js';
import { chooseDefault, cliListModels, detectCliProviders } from './cli-providers.js';

const PER_ROW = 4;
const INNER = 24; // book interior width
const BOOK = INNER + 2;
const WIDTH = PER_ROW * BOOK + (PER_ROW - 1);
const PREVIEW_ROWS = 2;

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'];
const SHORT = { none: '0', minimal: 'min', low: 'L', medium: 'M', high: 'H', xhigh: 'XH', 'extra-high': 'XH', max: 'MAX' };
const EFFORT_RE = new RegExp(`-(${EFFORTS.join('|')})$`);

/** "claude-opus-5-thinking-high-fast" -> { base, effort: 'high', thinking, fast } */
function splitVariant(id) {
  let rest = id;
  const fast = /-fast$/.test(rest);
  rest = rest.replace(/-fast$/, '');
  let thinking = /-thinking$/.test(rest);
  rest = rest.replace(/-thinking$/, '');
  const effort = rest.match(EFFORT_RE)?.[1] ?? null;
  rest = rest.replace(EFFORT_RE, '');
  if (/-thinking$/.test(rest)) thinking = true;
  rest = rest.replace(/-thinking$/, '');
  return { base: rest, effort, thinking, fast };
}

/** Stack variants into books. A "family" of one keeps its full id. */
function toBooks(ids) {
  const families = new Map();
  for (const id of ids) {
    const v = splitVariant(id);
    if (!families.has(v.base)) families.set(v.base, []);
    families.get(v.base).push({ id, ...v });
  }
  const books = [];
  for (const [base, members] of families) {
    if (members.length === 1) {
      books.push({ title: members[0].id, efforts: [], thinking: false, fast: false });
      continue;
    }
    const efforts = EFFORTS.filter((e) => members.some((m) => m.effort === e)).map((e) => SHORT[e]);
    books.push({
      title: base,
      efforts: [...new Set(efforts)],
      thinking: members.some((m) => m.thinking),
      fast: members.some((m) => m.fast),
      count: members.length,
    });
  }
  return books;
}

const fit = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));

function bookLines(b) {
  const tags = [b.thinking && 'think', b.fast && 'fast'].filter(Boolean).join('+');
  const line2 = [b.efforts.join(' '), tags].filter(Boolean).join(' · ') || (b.note ?? '');
  const mark = b.star ? '★' : ' ';
  return [
    '┌' + '─'.repeat(INNER) + '┐',
    '│' + fit(`${mark}${b.title}`, INNER) + '│',
    '│' + fit(` ${line2}`, INNER) + '│',
    '└' + '─'.repeat(INNER) + '┘',
  ];
}

function drawShelf(books) {
  const out = [];
  for (let i = 0; i < books.length; i += PER_ROW) {
    const row = books.slice(i, i + PER_ROW).map(bookLines);
    for (let l = 0; l < 4; l++) out.push(row.map((b) => b[l]).join(' '));
    out.push('▀'.repeat(WIDTH));
  }
  return out;
}

async function backendModels(p) {
  if (p.kind === 'cli') return cliListModels(p);
  return listModels(p);
}

function effortLine(p) {
  if (p.kind !== 'cli') return 'effort: low · medium · high (if the model reasons)';
  if (p.efforts) return `effort: ${p.efforts.join(' · ')}`;
  return `effort: in the model id (${p.effortNote ?? 'no flag'})`;
}

async function main() {
  const arg = (process.argv[2] || '').trim().toLowerCase();
  const providers = loadProviders();
  for (const [id, p] of await detectCliProviders()) providers.set(id, p);
  const defaultId = chooseDefault(providers);

  let wanted = [...providers.values()];
  if (arg && arg !== 'all') {
    wanted = wanted.filter((p) => p.id === arg);
    if (!wanted.length) {
      console.log(`No backend "${arg}". Available: ${[...providers.keys()].join(', ')}`);
      process.exit(1);
    }
  }
  const showAll = Boolean(arg);

  // Listing is slow per backend (it spawns the CLI), so do them all at once.
  const listed = await Promise.all(
    wanted.map((p) => backendModels(p).then((ids) => ({ ids }), (e) => ({ error: e.message })))
  );

  const lines = [];
  const title = ' MODEL SHELF ';
  const pad = WIDTH - title.length - 2;
  lines.push('╔' + '═'.repeat(WIDTH - 2) + '╗');
  lines.push('║' + ' '.repeat(Math.floor(pad / 2)) + title + ' '.repeat(Math.ceil(pad / 2)) + '║');
  lines.push('╚' + '═'.repeat(WIDTH - 2) + '╝');

  wanted.forEach((p, i) => {
    const { ids = [], error } = listed[i];
    // opencode ids all start with "opencode/"; a shared prefix only eats width.
    const prefix = ids[0]?.match(/^[^/]+\//)?.[0];
    const shared = prefix && ids.every((id) => id.startsWith(prefix)) ? prefix : '';
    let books = toBooks(ids.map((id) => id.slice(shared.length)));

    // Backends without a model list still get a book for their own default.
    if (!books.length && !error) {
      books = [{ title: `${p.id} (default)`, efforts: [], note: 'the CLI picks the model' }];
    }
    for (const b of books) if (p.defaultModel && b.title === p.defaultModel) b.star = true;

    const star = p.id === defaultId ? '  ★ DEFAULT' : '';
    const kind = p.kind === 'cli' ? 'subscription, no key' : 'API key, billed per token';
    lines.push('');
    lines.push(` ${p.id.toUpperCase()}${star}  —  ${p.label ?? p.id}  (${kind})`);
    lines.push(
      ` ${effortLine(p)}  │  ${ids.length} models on ${books.length} books` +
        (p.defaultModel ? `  │  ★ = ${p.defaultModel} (used by default)` : '') +
        (shared ? `  │  prefix: ${shared}` : '')
    );
    if (error) {
      lines.push(` ⚠ could not list models: ${error.slice(0, WIDTH - 30)}`);
      return;
    }

    const limit = showAll ? books.length : PREVIEW_ROWS * PER_ROW;
    let shown = books.slice(0, limit);
    const hidden = books.length - shown.length;
    if (hidden > 0) {
      shown = shown.slice(0, limit - 1);
      shown.push({ title: `… +${hidden + 1} more`, efforts: [], note: `/shelf ${p.id}` });
    }
    lines.push(...drawShelf(shown));
  });

  lines.push('');
  lines.push(' Key: 0=none  min=minimal  L=low  M=medium  H=high  XH=xhigh  MAX=max  ·  think=thinking variant  fast=fast variant');
  lines.push(' Call: ask_model(model: "<backend>:<model>", effort: "low|medium|high")');
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(`shelf failed: ${e.message}`);
  process.exit(1);
});
