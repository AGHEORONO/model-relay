import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSkills } from '../src/skills.js';

// loadSkills looks in <cwd>/.claude/skills first, so a temp cwd is enough.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-test-'));
const cwd = process.cwd();
process.chdir(dir);
await fs.mkdir(path.join(dir, '.claude', 'skills', 'lazy'), { recursive: true });
await fs.writeFile(
  path.join(dir, '.claude', 'skills', 'lazy', 'SKILL.md'),
  '---\nname: lazy\ndescription: "x: y"\n---\n\n# Lazy\nWrite the shortest code.\n'
);

after(async () => {
  process.chdir(cwd);
  await fs.rm(dir, { recursive: true, force: true });
});

test('no skills gives no instructions', async () => {
  assert.equal(await loadSkills([]), '');
});

test('a skill body is wrapped and its frontmatter dropped', async () => {
  const text = await loadSkills(['lazy']);
  assert.match(text, /<skill name="lazy">\n# Lazy\nWrite the shortest code.\n<\/skill>/);
  assert.doesNotMatch(text, /description:/);
});

test('unknown and path-like names are rejected', async () => {
  await assert.rejects(loadSkills(['missing-skill']), /skill not found/);
  await assert.rejects(loadSkills(['../../etc']), /invalid skill name/);
  await assert.rejects(loadSkills(['plugin:../x']), /invalid skill name/);
});
