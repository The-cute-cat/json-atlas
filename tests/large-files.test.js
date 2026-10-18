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

function fixture(value, cache = new PageCache(), searchBatch = false) {
  const memory = new MemoryDataSource(value), calls = [];
  const info = { root: memory.getRoot(), kind: 'json', records: 0, badCount: 0, commentCount: 0 };
  if (searchBatch) info.searchBatch = true;
  const request = async (op, id, args) => {
    calls.push({ op, id, args });
    if (op === 'page') return memory.getChildren(args.path, args);
    if (op === 'searchPages') return Promise.all(args.paths.map(path => memory.getChildren(path, { limit: 16 })));
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

test('search batches preserve DFS hits and reduce requests without caching reading pages', async () => {
  const value = Array.from({ length: 205 }, (_, i) => ({ i, text: `row-${i}`, n: i, active: true, empty: null, secret: 'row-204' }));
  const old = fixture(value), batched = fixture(value, new PageCache(), true);
  const options = { hidden: new Set(['$[].secret']), indexBase: 1 };
  assert.deepEqual(await batched.source.search('row-204', options), await old.source.search('row-204', options));
  assert.deepEqual((await batched.source.search('205', options)).hits, [[204]]);
  // Measure one complete traversal independently of the second index-label query.
  const counted = fixture(value, new PageCache(), true);
  await counted.source.search('row-204', options);
  assert.equal(old.calls.length, 208);
  assert.equal(counted.calls.length, 31);
  for (const call of counted.calls.filter(call => call.op === 'searchPages')) {
    assert(call.args.paths.length <= 8);
    assert(call.args.paths.every(path => path.length === 1));
  }
  assert.equal(counted.cache.stats.entries, 0);
  for (const item of [old, batched, counted]) item.source.dispose();
});

test('batch search cancellation and fallback do not read later branches after an early match', async () => {
  const value = [{ text: 'target' }, { text: 'later' }], memory = new MemoryDataSource(value);
  for (const cancel of [true, false]) {
    const calls = []; let cancelled = false;
    const source = new IndexedDataSource(async (op, id, args) => {
      calls.push({ op, args });
      if (op === 'page') return memory.getChildren(args.path, args);
      if (op === 'searchPages') { cancelled = cancel; throw new Error('later branch cannot be resolved'); }
    }, 'batch-fallback', { root: memory.getRoot(), searchBatch: true });
    const result = await source.search('target', { limit: 1, cancelled: () => cancelled });
    if (cancel) assert.equal(result, null);
    else assert.deepEqual(result, { hits: [[0, 'text']], truncated: true });
    assert(!calls.some(c => c.op === 'page' && c.args.path[0] === 1));
    source.dispose();
  }
});

test('batch search rejects late responses after view changes and file changes', async () => {
  const memory = new MemoryDataSource([{ text: 'target' }, { text: 'target' }]);
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const info = { root: memory.getRoot(), searchBatch: true };
  const source = new IndexedDataSource(async (op, id, args) => {
    if (op === 'page') return memory.getChildren(args.path, args);
    if (op === 'searchPages') { began(); return new Promise(resolve => { release = resolve; }); }
    if (op === 'info') return info;
  }, 'batch-change', info);
  const pending = source.search('target');
  await started; await source.configure(false, false);
  release(await Promise.all([[0], [1]].map(path => memory.getChildren(path))));
  await assert.rejects(pending, { name: 'AbortError' });
  source.dispose();

  const staleCache = new PageCache();
  const changed = new IndexedDataSource(async (op, id, args) => {
    if (op === 'page') return memory.getChildren(args.path, args);
    if (op === 'searchPages') return Promise.all(args.paths.map(path => memory.getChildren(path)));
    if (op === 'check') throw new Error('文件已发生变化');
  }, 'batch-file-change', info, true, { cache: staleCache });
  await changed.getChildren([]);
  assert.equal(staleCache.stats.entries, 1);
  await assert.rejects(changed.search('target'), /文件已发生变化/);
  assert.equal(staleCache.stats.entries, 0);
  changed.dispose();
});

test('batch search skips hidden subtrees and keeps JavaScript Unicode matching', async () => {
  const value = { a: { text: 'ΟΣ İ' }, hidden: { text: 'ΟΣ İ' }, b: { text: 'ΟΣ İ' } };
  const old = fixture(value), batched = fixture(value, new PageCache(), true);
  const options = { hidden: new Set(['$.hidden']) };
  for (const query of ['ος', 'i\u0307']) {
    assert.deepEqual(await batched.source.search(query, options), await old.source.search(query, options));
  }
  assert(batched.calls.filter(call => call.op === 'searchPages').every(call => call.args.paths.every(path => path[0] !== 'hidden')));
  old.source.dispose(); batched.source.dispose();
});

test('abort or close during a successful batch rejects without another page request', async () => {
  const memory = new MemoryDataSource([{ text: 'target' }, { text: 'target' }]);
  for (const close of [false, true]) {
    const controller = new AbortController(), calls = [];
    let source;
    source = new IndexedDataSource(async (op, id, args) => {
      calls.push(op);
      if (op === 'page') return memory.getChildren(args.path, args);
      if (op === 'searchPages') {
        const pages = await Promise.all(args.paths.map(path => memory.getChildren(path)));
        if (close) source.dispose(); else controller.abort();
        return pages;
      }
    }, 'batch-abort', { root: memory.getRoot(), searchBatch: true });
    await assert.rejects(source.search('target', { signal: controller.signal }), close ? /文档已关闭/ : { name: 'AbortError' });
    assert.equal(calls.filter(op => op === 'page').length, 1);
    source.dispose();
  }
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
