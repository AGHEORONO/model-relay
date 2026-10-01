/**
 * Append one line per delegated call to ~/.claude/model-relay/ledger.jsonl,
 * so `/relay stats` can show what relay actually saved. Sizes only — never
 * prompt or reply text.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const DIR = path.join(homedir(), '.claude', 'model-relay');

export async function record(entry) {
  try {
    await mkdir(DIR, { recursive: true });
    await appendFile(path.join(DIR, 'ledger.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    /* stats are best-effort; never fail a model call over them */
  }
}
