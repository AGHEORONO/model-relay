/**
 * Attach local files to a delegated prompt.
 *
 * The point is token economy: without this, Claude has to paste file contents
 * into the prompt — i.e. *write* them as output tokens, the expensive kind.
 * With it, Claude passes paths and the server reads the files itself.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 1024 * 1024;

// Never ship credentials to another vendor, even if asked to.
const SECRET = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.(ssh|aws|gnupg)[\\/]/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])(credentials|secrets?)(\.[a-z]+)?$/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)$/i,
];

export function isSecretPath(p) {
  return SECRET.some((re) => re.test(p));
}

/** Read files into fenced blocks. Returns { text, chars, paths } or throws. */
export async function loadFiles(paths = [], { budget = MAX_TOTAL } = {}) {
  const blocks = [];
  let total = 0;
  for (const raw of paths) {
    const abs = path.resolve(String(raw));
    if (isSecretPath(abs)) throw new Error(`refusing to send a credentials file: ${raw}`);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`not a readable file: ${raw}`);
    if (info.size > MAX_FILE) throw new Error(`file too large (${Math.round(info.size / 1024)} KB > 256 KB): ${raw}`);
    const body = await readFile(abs, 'utf8');
    total += body.length;
    if (total > budget) throw new Error(`attached files exceed ${Math.round(budget / 1024)} KB in total`);
    blocks.push(`===== FILE: ${raw} =====\n${body}${body.endsWith('\n') ? '' : '\n'}===== END FILE =====`);
  }
  return { text: blocks.join('\n\n'), chars: total, paths };
}

/**
 * Write a delegated reply straight to disk, so Claude never re-types it.
 * Strips one fence wrapping the whole reply (```js ... ```), since models add
 * them even when told not to. Returns what was written, for the tool result.
 */
export async function writeOutput(file, reply, { overwrite = false } = {}) {
  const abs = path.resolve(String(file));
  if (isSecretPath(abs)) throw new Error(`refusing to write a credentials file: ${file}`);
  if (!overwrite && (await stat(abs).catch(() => null))) {
    throw new Error(`${file} already exists (pass overwrite: true to replace it)`);
  }
  const fenced = reply.trim().match(/^```[\w+-]*\n([\s\S]*?)\n```$/);
  const body = (fenced ? fenced[1] : reply.trim()) + '\n';
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body);
  return { path: file, chars: body.length, lines: body.split('\n').length - 1, stripped: Boolean(fenced) };
}
