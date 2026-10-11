import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, parseJsonl, searchData, walkData, PAGE_SIZE } from '../src/data.js';
import { pageRange } from '../src/paging.js';

test('JSON handles BOM, primitive roots, and a mislabeled JSONL file', () => {
  assert.deepEqual(parseDocument('\uFEFF{"中文":1}', 'data.json').parsed, { 中文: 1 });
  assert.equal(parseDocument('null', 'data.json').parsed, null);
  assert.equal(parseDocument('false', 'data.json').parsed, false);
  const result = parseDocument('{"a":1}\n{"a":2}', 'data.json');
  assert.equal(result.kind, 'jsonl');
  assert.deepEqual(result.records, [{ a: 1 }, { a: 2 }]);
  assert.match(parseDocument('invalid', 'data.json').error, /JSON/);
});

test('JSONL preserves error line numbers and strict-mode comment evidence', () => {
  const result = parseJsonl('\uFEFF{"a":1}\r\n\n# comment\n// comment\ninvalid\n{"a":2}\n');
  assert.deepEqual(result.records, [{ a: 1 }, { a: 2 }]);
  assert.equal(result.totalLines, 7);
  assert.deepEqual(result.bad.map(b => b.line), [3, 4, 5]);
  assert.deepEqual(result.bad.map(b => !!b.comment), [true, true, false]);
  assert.equal(parseDocument('', 'empty.jsonl').records.length, 0);
  assert(parseDocument('', 'empty.jsonl').error);
});

test('large JSONL scans without a split-line array and preserves last record', () => {
  const text = Array.from({ length: 100000 }, (_, id) => JSON.stringify({ id, text: '中文示例' })).join('\n');
  const result = parseDocument(text, 'large.ndjson');
  assert.equal(result.records.length, 100000);
  assert.equal(result.records.at(-1).id, 99999);
  assert.equal(result.bad.length, 0);
});

test('search reaches unloaded pages, respects hidden fields and index base', async () => {
  const value = Array.from({ length: 10000 }, (_, i) => ({ content: `value-${i}`, secret: 'hidden' }));
  const result = await searchData(value, 'value-9999');
  assert.deepEqual(result.hits, [[9999, 'content']]);
  const hidden = await searchData(value, 'hidden', { hidden: new Set(['$[0].secret']) });
  assert.deepEqual(hidden.hits, []);
  const labels = [...walkData(['x'], 'root', 1)];
  assert.equal(labels[1].text, '1 x');
});

test('search yields, cancels obsolete work and caps broad queries', async () => {
  let cancelled = false, yielded = false;
  const value = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
  const result = await searchData(value, 'does not exist', {
    cancelled: () => cancelled,
    yieldTask: async () => { yielded = true; cancelled = true; }
  });
  assert(yielded);
  assert.equal(result, null);
  const capped = await searchData(value, 'id');
  assert.equal(capped.hits.length, 1000);
  assert(capped.truncated);
});

test('iterative search handles deeply nested data without a recursive stack overflow', async () => {
  let value = 'needle';
  for (let i = 0; i < 1500; i++) value = { child: value };
  const result = await searchData(value, 'needle');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].length, 1500);
});

test('paging handles boundaries, last page, empty arrays and out-of-range indices', () => {
  assert.equal(PAGE_SIZE, 100);
  assert.deepEqual(pageRange(10001, 9999), { start: 9900, end: 10000 });
  assert.deepEqual(pageRange(10001, 10000), { start: 10000, end: 10001 });
  assert.deepEqual(pageRange(0), { start: 0, end: 0 });
  assert.deepEqual(pageRange(7, 500), { start: 0, end: 7 });
});
