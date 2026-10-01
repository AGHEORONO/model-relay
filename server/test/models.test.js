import test from 'node:test';
import assert from 'node:assert/strict';
import { familyOf, parseAlias, pickModel, splitVariant } from '../src/models.js';

const AGY = [
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'gemini-3.7-flash-high', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
  'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
];

test('splitVariant peels effort, thinking and fast suffixes', () => {
  assert.deepEqual(splitVariant('claude-opus-5-thinking-high-fast'),
    { base: 'claude-opus-5', effort: 'high', thinking: true, fast: true });
  assert.deepEqual(splitVariant('gpt-5.5-extra-high'),
    { base: 'gpt-5.5', effort: 'extra-high', thinking: false, fast: false });
});

test('parseAlias', () => {
  assert.deepEqual(parseAlias('@fast'), { tier: 'fast', family: null });
  assert.deepEqual(parseAlias('@smart-claude'), { tier: 'smart', family: 'claude' });
  assert.equal(parseAlias('gemini-3.8-flash'), null);
});

test('@fast picks the newest flash and honours effort', () => {
  assert.equal(pickModel(AGY, 'fast', { family: 'gemini', effort: 'low' }), 'gemini-3.8-flash-low');
  assert.equal(pickModel(AGY, 'fast', { family: 'gemini' }), 'gemini-3.8-flash-medium');
});

test('"gemini" is not mistaken for a "mini" model', () => {
  assert.equal(pickModel(AGY, 'smart', { family: 'gemini', effort: 'high' }), 'gemini-3.1-pro-high');
});

test('@smart prefers top tier over mid tier at the same version', () => {
  assert.equal(pickModel(AGY, 'smart', { family: 'claude' }), 'claude-opus-4-6-thinking');
});

test('newer versions win and unstable builds lose', () => {
  const ids = ['x/gpt-5.4', 'x/gpt-6.1-sol', 'x/gpt-6-luna', 'x/gpt-7-preview-free', 'x/gpt-5.4-mini'];
  assert.equal(pickModel(ids, 'smart', { family: 'gpt' }), 'x/gpt-6.1-sol');
  assert.equal(pickModel(ids, 'fast', { family: 'gpt' }), 'x/gpt-5.4-mini');
});

test('familyOf ignores provider prefixes and versions', () => {
  assert.equal(familyOf('opencode/claude-opus-4-7'), 'claude');
  assert.equal(familyOf('qwen3.8-max'), 'qwen');
});
