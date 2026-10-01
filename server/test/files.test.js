import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSecretPath, loadFiles } from '../src/files.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'files-test-'));

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('isSecretPath identifies credential paths', () => {
  for (const file of [
    '.env',
    '.env.local',
    '/home/u/.ssh/config',
    'C:\\Users\\u\\.aws\\credentials',
    'id_rsa',
    'id_ed25519.pub',
    'server.pem',
    'cert.key',
    'credentials.json',
    'secrets.yaml',
    '.npmrc',
    'C:\\Users\\u\\.git-credentials',
  ]) {
    assert.equal(isSecretPath(file), true, file);
  }

  for (const file of [
    'src/env.js',
    'environment.md',
    'keyboard.js',
    'README.md',
    'secretary.txt',
  ]) {
    assert.equal(isSecretPath(file), false, file);
  }
});

test('loadFiles returns an empty attachment for no paths', async () => {
  assert.deepEqual(await loadFiles([]), { text: '', chars: 0, paths: [] });
});

test('loadFiles formats file blocks and counts body characters', async () => {
  const first = path.join(dir, 'first.txt');
  const second = path.join(dir, 'second.txt');
  const firstBody = 'first body\n';
  const secondBody = 'second body';

  await fs.writeFile(first, firstBody);
  await fs.writeFile(second, secondBody);

  const result = await loadFiles([first, second]);

  assert.equal(
    result.text,
    `===== FILE: ${first} =====\n${firstBody}===== END FILE =====\n\n` +
      `===== FILE: ${second} =====\n${secondBody}\n===== END FILE =====`,
  );
  assert.equal(result.chars, firstBody.length + secondBody.length);
  assert.deepEqual(result.paths, [first, second]);
});

test('loadFiles rejects secret files', async () => {
  const secret = path.join(dir, '.env');
  await fs.writeFile(secret, 'TOKEN=secret');

  await assert.rejects(loadFiles([secret]), /credentials file/);
});

test('loadFiles rejects missing paths', async () => {
  await assert.rejects(
    loadFiles([path.join(dir, 'missing.txt')]),
    /not a readable file/,
  );
});

test('loadFiles rejects directories', async () => {
  const folder = path.join(dir, 'folder');
  await fs.mkdir(folder);

  await assert.rejects(loadFiles([folder]), /not a readable file/);
});

test('loadFiles rejects files over 256 KB', async () => {
  const large = path.join(dir, 'large.txt');
  await fs.writeFile(large, 'x'.repeat(256 * 1024 + 1));

  await assert.rejects(loadFiles([large]), /too large/);
});

test('loadFiles rejects files exceeding the total budget', async () => {
  const first = path.join(dir, 'budget-one.txt');
  const second = path.join(dir, 'budget-two.txt');
  await fs.writeFile(first, '123456');
  await fs.writeFile(second, 'abcdef');

  await assert.rejects(loadFiles([first, second], { budget: 10 }), /exceed/);
});
