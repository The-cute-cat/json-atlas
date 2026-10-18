import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThreshold, needsIndex, IndexedDataSource } from '../src/large-files.js';
import { MemoryDataSource } from '../src/data-source.js';
import { PageCache } from '../src/page-cache.js';

function nativeFixture() {
  const calls = [], pending = [];
  const info = { root: { path: [], type: 'object', childCount: 1 }, nativeSearch: true };
  const cache = new PageCache();
  const source = new IndexedDataSource(async (op, id, args) => {
    calls.push({ op, id, args });
    if (op === 'search') return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    if (op === 'info') return info;
    if (op === 'page') return { start: 0, end: 0, total: 0, items: [] };
  }, 'native-test', info, true, { cache });
  return { source, calls, pending, cache };
}

test('native search sends one bounded result request and preserves all matching options', async () => {
  const { source, calls, pending, cache } = nativeFixture();
  const search = source.search('中文😀', { rootLabel: '根', indexBase: 1, hidden: new Set(['$.secret']), limit: 3 });
  assert.equal(calls.length, 1); assert.equal(calls[0].op, 'search');
  assert.deepEqual({ ...calls[0].args, searchId: 'id' }, { searchId: 'id', query: '中文😀', rootLabel: '根', indexBase: 1, hidden: ['$.secret'], limit: 3, wrap: true });
  const result = { hits: [['value']], truncated: false };
  pending[0].resolve(result); assert.deepEqual(await search, result);
  assert.equal(cache.stats.entries, 0); source.dispose();
});

test('native search cancellation retries independently of the pending document request', async () => {
  const { source, calls, pending } = nativeFixture(); let cancelled = false;
  const search = source.search('target', { cancelled: () => cancelled });
  cancelled = true;
  await new Promise(resolve => setTimeout(resolve, 110));
  assert(calls.filter(c => c.op === 'searchCancel').length >= 2);
  pending[0].reject(new Error('已取消')); assert.equal(await search, null);
  const count = calls.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls.length, count); source.dispose();
});

test('native search abort, close, replacement and configuration reject or discard stale results', async () => {
  for (const action of ['abort', 'close', 'replace', 'configure']) {
    const { source, calls, pending } = nativeFixture(); const control = new AbortController();
    const search = source.search('first', { signal: control.signal });
    let newer;
    if (action === 'abort') control.abort();
    if (action === 'close') source.dispose();
    if (action === 'replace') newer = source.search('second');
    if (action === 'configure') await source.configure(false, false);
    assert(calls.some(c => c.op === 'searchCancel'));
    pending[0].resolve({ hits: [[]], truncated: false });
    if (action === 'abort' || action === 'configure') await assert.rejects(search, { name: 'AbortError' });
    else if (action === 'close') await assert.rejects(search, /关闭/);
    else { assert.equal(await search, null); pending[1].resolve({ hits: [], truncated: false }); await newer; }
    source.dispose();
  }
});

test('native search errors clear reading cache and pre-cancelled requests never start', async () => {
  const { source, calls, pending, cache } = nativeFixture();
  await source.getChildren([]); assert.equal(cache.stats.entries, 1);
  const search = source.search('target'); pending[0].reject(new Error('文件已变化'));
  await assert.rejects(search, /文件已变化/); assert.equal(cache.stats.entries, 0);
  const count = calls.length;
  assert.equal(await source.search('target', { cancelled: () => true }), null);
  const control = new AbortController(); control.abort();
  await assert.rejects(source.search('target', { signal: control.signal }), { name: 'AbortError' });
  assert.equal(calls.length, count); source.dispose();
});

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

test('lone UTF-16 surrogate queries use local fallback while valid pairs use native search', async () => {
  const { source, calls } = fixture({ text: 'a\uD800z' });
  source.info.nativeSearch = true;
  assert.deepEqual((await source.search('\uD800')).hits, [['text']]);
  assert(!calls.some(c => c.op === 'search'));
  source.dispose();
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
