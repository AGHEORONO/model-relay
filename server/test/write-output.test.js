import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeOutput } from '../src/files.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-output-test-'));

after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('writes a plain reply trimmed with one trailing newline', async () => {
  const file = path.join(tempDir, 'plain.txt');
  const result = await writeOutput(file, '  Hello\nworld  \n\n');

  assert.deepEqual(result, {
    path: file,
    chars: 12,
    lines: 2,
    stripped: false,
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'Hello\nworld\n');
});

test('strips a wrapping language fence', async () => {
  const file = path.join(tempDir, 'javascript.js');
  const result = await writeOutput(file, '```js\nconst answer = 42;\n```');

  assert.equal(await fs.readFile(file, 'utf8'), 'const answer = 42;\n');
  assert.equal(result.stripped, true);
});

test('strips a wrapping bare fence', async () => {
  const file = path.join(tempDir, 'bare.txt');
  const result = await writeOutput(file, '```\nplain text\n```');

  assert.equal(await fs.readFile(file, 'utf8'), 'plain text\n');
  assert.equal(result.stripped, true);
});

test('leaves a non-wrapping fence untouched', async () => {
  const file = path.join(tempDir, 'partial.txt');
  const reply = 'Before the fence\n```js\nconst answer = 42;\n```';
  const result = await writeOutput(file, reply);

  assert.equal(await fs.readFile(file, 'utf8'), `${reply}\n`);
  assert.equal(result.stripped, false);
});

test('creates missing parent directories', async () => {
  const file = path.join(tempDir, 'a', 'b', 'c', 'out.txt');

  await writeOutput(file, 'created');

  assert.equal(await fs.readFile(file, 'utf8'), 'created\n');
});

test('does not overwrite an existing file unless requested', async () => {
  const file = path.join(tempDir, 'existing.txt');
  await fs.writeFile(file, 'original');

  await assert.rejects(writeOutput(file, 'replacement'), /already exists/);
  assert.equal(await fs.readFile(file, 'utf8'), 'original');

  await writeOutput(file, 'replacement', { overwrite: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement\n');
});

test('rejects credential paths without writing files', async () => {
  for (const name of ['.env', 'id_rsa']) {
    const file = path.join(tempDir, name);

    await assert.rejects(writeOutput(file, 'secret'), /credentials file/);
    await assert.rejects(fs.stat(file));
  }
});
