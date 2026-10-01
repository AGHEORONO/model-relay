import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_LEN = 500;
const load = (cfg) => { try { return JSON.parse(readFileSync(cfg.file, 'utf8')); } catch { return []; } };
const save = (cfg, notes) => { mkdirSync(path.dirname(cfg.file), { recursive: true }); writeFileSync(cfg.file, JSON.stringify(notes, null, 2)); };
const show = (n, cfg) => `#${n.id} ${cfg.dateFormat === 'iso' ? n.at : ago(n.at)}  ${n.text}${n.tags.length ? '  [' + n.tags.join(', ') + ']' : ''}`;
const ago = (iso) => `${Math.round((Date.now() - Date.parse(iso)) / 60000)} min ago`;

export function addNote(cfg, text) {
  if (!text.trim()) throw new Error('note text is empty');
  if (text.length > MAX_LEN) throw new Error(`note is longer than ${MAX_LEN} characters`);
  const notes = load(cfg);
  const id = (notes.at(-1)?.id ?? 0) + 1;
  notes.push({ id, text: text.trim(), tags: [], at: new Date().toISOString() });
  save(cfg, notes);
  return `added #${id}`;
}
export const listNotes = (cfg, { limit }) => load(cfg).slice(-limit).map((n) => show(n, cfg)).join('\n') || '(no notes)';
export function searchNotes(cfg, q) {
  if (!q) throw new Error('search needs a query');
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\]/g, '\$&'), 'i');
  return load(cfg).filter((n) => re.test(n.text) || n.tags.some((t) => re.test(t))).map((n) => show(n, cfg)).join('\n') || '(no matches)';
}
export function removeNote(cfg, id) {
  const notes = load(cfg);
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0) throw new Error(`no note #${id}`);
  notes.splice(i, 1);
  save(cfg, notes);
  return `removed #${id}`;
}
export function tagNote(cfg, id, tags) {
  const notes = load(cfg);
  const n = notes.find((x) => x.id === id);
  if (!n) throw new Error(`no note #${id}`);
  if (!tags.length) throw new Error('tag needs at least one tag');
  n.tags = [...new Set([...n.tags, ...tags.map((t) => t.replace(/^#/, ''))])];
  save(cfg, notes);
  return `#${id} tagged ${n.tags.join(', ')}`;
}
export function exportNotes(cfg, format) {
  const notes = load(cfg);
  if (format === 'json') return JSON.stringify(notes, null, 2);
  if (format === 'csv') return ['id,at,text,tags', ...notes.map((n) => `${n.id},${n.at},"${n.text.replace(/"/g, '""')}",${n.tags.join(';')}`)].join('\n');
  if (format === 'markdown') return notes.map((n) => `- **#${n.id}** ${n.text}`).join('\n');
  throw new Error(`unknown export format "${format}" (use markdown, json or csv)`);
}
