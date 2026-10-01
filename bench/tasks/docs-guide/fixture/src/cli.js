#!/usr/bin/env node
import { addNote, listNotes, searchNotes, removeNote, exportNotes, tagNote } from './store.js';
import { loadConfig } from './config.js';

const [cmd, ...args] = process.argv.slice(2);
const cfg = loadConfig();

const commands = {
  add: () => addNote(cfg, args.join(' ')),
  list: () => listNotes(cfg, { limit: Number(args[0]) || cfg.pageSize }),
  search: () => searchNotes(cfg, args.join(' ')),
  rm: () => removeNote(cfg, Number(args[0])),
  tag: () => tagNote(cfg, Number(args[0]), args.slice(1)),
  export: () => exportNotes(cfg, args[0] ?? 'markdown'),
};

if (!commands[cmd]) {
  console.error(`Unknown command "${cmd ?? ''}". Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
try {
  const out = commands[cmd]();
  if (out !== undefined) console.log(out);
} catch (e) {
  console.error(`jot: ${e.message}`);
  process.exit(1);
}
