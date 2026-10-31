import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceValue, parseEdit, serializeDocument } from '../src/editing.js';

test('replacement copies ancestry, preserves siblings and prototype-shaped JSON keys', () => {
  const original = JSON.parse('{"__proto__":{"x":1},"items":[{"n":2}],"same":{"a":1}}');
  const next = replaceValue(original, ['items', 0, 'n'], 3);
  assert.equal(original.items[0].n, 2); assert.equal(next.items[0].n, 3);
  assert.equal(next.same, original.same);
  const special = replaceValue(original, ['__proto__', 'x'], 9);
  assert.equal(special.__proto__.x, 9); assert.equal({}.x, undefined);
  assert.throws(() => replaceValue(original, ['missing'], 0));
  assert.equal(replaceValue(original, [], false), false);
});

test('typed editing rejects invalid JSON, mismatched types and nonfinite numbers', () => {
  assert.equal(parseEdit('"hello"', 'string'), '"hello"');
  assert.equal(parseEdit('false', 'boolean'), false);
  assert.equal(parseEdit('null', 'null'), null);
  assert.throws(() => parseEdit('1e400', 'number'));
  assert.throws(() => parseEdit('{}', 'array'));
  assert.throws(() => parseEdit('{bad}', 'object'));
});

test('exports preserve JSONL record boundaries including embedded newlines', () => {
  const records = [{text:'a\nb'}, false, ['x']];
  const text = serializeDocument({kind:'jsonl', records});
  assert.deepEqual(text.trimEnd().split('\n').map(s => JSON.parse(s)), records);
});
