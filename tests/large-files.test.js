import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThreshold, needsIndex, IndexedDataSource } from '../src/large-files.js';
import { MemoryDataSource } from '../src/data-source.js';
import { PageCache } from '../src/page-cache.js';

test('threshold accepts exactly four sizes and routes only strictly larger files', () => {
  for (const n of [32, 64, 128, 256]) {
    assert.equal(normalizeThreshold(String(n)), n);
    assert.equal(needsIndex(n * 1024 ** 2, n), false);
    assert.equal(needsIndex(n * 1024 ** 2 + 1, n), true);
  }
  for (const n of [undefined, null, NaN, Infinity, -1, 0, 31, 33, 95, 128.5, 255, 257, 'oops']) assert.equal(normalizeThreshold(n), 64);
});

function fixture(value, cache = new PageCache()) {
  const memory = new MemoryDataSource(value), calls = [];
  const info = { root: memory.getRoot(), kind: 'json', records: 0, badCount: 0, commentCount: 0 };
  const request = async (op, id, args) => {
    calls.push({ op, id, args });
    if (op === 'page') return memory.getChildren(args.path, args);
    if (op === 'text') return memory.getText(args.path);
    if (op === 'info') return info;
  };
  return { source: new IndexedDataSource(request, 'test-id', info, true, { cache }), calls, cache };
}

test('indexed adapter requests only pages and text explicitly requested by the reader', async () => {
  const { source, calls } = fixture({ rows: Array.from({ length: 205 }, (_, i) => ({ i })) });
  assert.equal(source.getRoot().childCount, 1); assert.equal(calls.length, 0);
  const page = await source.getChildren(['rows'], { key: 204 });
  assert.equal(page.start, 200); assert.equal(page.items.length, 5);
  assert.equal(await source.getText(['rows', 204, 'i']), '204');
  assert.deepEqual(calls.map(c => c.op), ['page', 'text']);
  await assert.rejects(source.getChildren([], { limit: 101 }), /分页/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(source.getChildren([], { signal: abort.signal }), { name: 'AbortError' });
  source.dispose(); source.dispose(); assert.equal(calls.at(-1).op, 'close');
  assert.throws(() => source.getRoot(), /关闭/);
});

test('indexed search crosses pages, respects hidden fields and can cancel between reads', async () => {
  const { source, calls } = fixture({ rows: Array.from({ length: 205 }, (_, i) => ({ text: `row-${i}` })), secret: 'row-204' });
  const result = await source.search('row-204', { hidden: new Set(['$.secret']) });
  assert.deepEqual(result.hits, [['rows', 204, 'text']]);
  assert(calls.some(c => c.args?.offset === 200));
  const count = calls.length;
  assert.equal(await source.search('nothing', { cancelled: () => calls.length > count }), null);
  assert(calls.length <= count + 1);
});

test('latest JSONL configuration wins and uses the requested wrap option', async () => {
  const pending = [];
  const source = new IndexedDataSource((op, id, args) => new Promise(resolve => pending.push({ args, resolve })), 'config', { root: { type: 'array' } });
  const older = source.configure(false, false), newer = source.configure(true, false);
  assert.equal(pending[0].args.wrap, false);
  pending[1].resolve({ root: { type: 'array', childCount: 2 } }); await newer;
  pending[0].resolve({ root: { type: 'object', childCount: 1 } }); await older;
  assert.equal(source.getRoot().type, 'array'); assert.equal(source.wrap, true);
});

test('revisiting a page and locating a key reuse its data after a file-change check', async () => {
  const { source, calls } = fixture(Array.from({ length: 205 }, (_, i) => i));
  const first = await source.getChildren([], { offset: 100 });
  assert.equal(await source.getChildren([], { key: 104 }), first);
  assert.equal(await source.getChildren([], { offset: 150 }), first);
  assert.equal(calls.filter(c => c.op === 'page').length, 1);
  assert.equal(calls.filter(c => c.op === 'check').length, 2);
  await source.getChildren([], { offset: 100, limit: 50 });
  assert.equal(calls.filter(c => c.op === 'page').length, 2);
  source.dispose();
});

test('search does not fill or evict reading history and only the next page is prefetched', async () => {
  const { source, calls, cache } = fixture(Array.from({ length: 205 }, (_, i) => `row-${i}`));
  const page = await source.getChildren([]), release = source.retainPage([], page);
  await source.prefetchChildren([], page);
  assert.deepEqual(calls.filter(c => c.op === 'page').map(c => c.args.offset), [0, 100]);
  assert.equal(cache.stats.pinned, 1);
  const before = cache.stats.entries;
  assert.equal((await source.search('row-204')).hits.length, 1);
  assert.equal(cache.stats.entries, before);
  const reads = calls.filter(c => c.op === 'page').length;
  await source.getChildren([], { offset: 100 });
  assert.equal(calls.filter(c => c.op === 'page').length, reads);
  release(); assert.equal(cache.stats.pinned, 0); source.dispose();
});

test('shared requests survive cancellation of one reader and do not admit aborted-only responses', async () => {
  const memory = new MemoryDataSource([42]), cache = new PageCache();
  let resolve, reads = 0;
  const source = new IndexedDataSource(async op => {
    if (op === 'page') { reads++; return new Promise(r => { resolve = r; }); }
  }, 'shared', { root: memory.getRoot() }, true, { cache });
  const cancelled = new AbortController();
  const first = source.getChildren([], { signal: cancelled.signal }), second = source.getChildren([]);
  cancelled.abort(); resolve(await memory.getChildren([]));
  const result = await Promise.allSettled([first, second]);
  assert.equal(reads, 1); assert.equal(result[0].reason.name, 'AbortError');
  assert.equal(result[1].value.items[0].value, 42); assert.equal(cache.stats.entries, 1);
  source.dispose(); assert.equal(cache.stats.bytes, 0);

  const aborted = new AbortController();
  const another = new IndexedDataSource(async op => op === 'page' ? new Promise(r => { resolve = r; }) : null,
    'aborted', { root: memory.getRoot() }, true, { cache });
  const only = another.getChildren([], { signal: aborted.signal }); aborted.abort();
  resolve(await memory.getChildren([])); await assert.rejects(only, { name: 'AbortError' });
  assert.equal(cache.stats.entries, 0); another.dispose();
});

test('file changes invalidate cached data and are reported instead of returning a stale page', async () => {
  const memory = new MemoryDataSource([1]), cache = new PageCache();
  let changed = false;
  const source = new IndexedDataSource(async op => {
    if (op === 'page') return memory.getChildren([]);
    if (op === 'check' && changed) throw new Error('文件已发生变化');
  }, 'changes', { root: memory.getRoot() }, true, { cache });
  await source.getChildren([]); assert.equal(cache.stats.entries, 1); changed = true;
  await assert.rejects(source.getChildren([]), /文件已发生变化/);
  assert.equal(cache.stats.bytes, 0); source.dispose();
});

test('JSONL root changes discard history and reject an old page still in flight', async () => {
  const memory = new MemoryDataSource([1, 2]), cache = new PageCache();
  let complete;
  const source = new IndexedDataSource(async op => {
    if (op === 'page') return new Promise(resolve => { complete = resolve; });
    if (op === 'info') return { root: memory.getRoot() };
  }, 'configuration', { root: memory.getRoot() }, true, { cache });
  const old = source.getChildren([]); await source.configure(false, false);
  complete(await memory.getChildren([])); await assert.rejects(old, { name: 'AbortError' });
  assert.equal(cache.stats.entries, 0); source.dispose();
});
