import test from 'node:test';
import assert from 'node:assert/strict';
import { PageCache, estimatePageBytes } from '../src/page-cache.js';

const page = (start, value = 'x'.repeat(100)) => ({ start, end: start + 100, total: 500,
  items: [{ key: start, path: [start], type: 'string', value }] });
const find = (cache, start, owner = 1, group = 'rows') => cache.lookup(owner, group, { offset: start });

test('byte budget evicts the least recently read page and oversized values are never admitted', () => {
  const probe = new PageCache(); probe.put(1, 'rows', page(100));
  const cache = new PageCache({ budget: probe.stats.bytes * 2 + 20 });
  cache.put(1, 'rows', page(0)); cache.put(1, 'rows', page(100));
  cache.touch(find(cache, 0).id); cache.put(1, 'rows', page(200));
  assert(find(cache, 0)); assert.equal(find(cache, 100), null); assert(find(cache, 200));
  assert(cache.stats.bytes <= cache.stats.budget);
  assert.equal(cache.put(1, 'rows', page(300, 'x'.repeat(100000))), null);
  assert.equal(cache.stats.entries, 2);
  assert(estimatePageBytes(page(0, '中文')) > estimatePageBytes(page(0, 'a')));
});

test('visible-page leases are independent, idempotent and cannot exceed the budget', () => {
  const cache = new PageCache({ maxEntries: 1 });
  cache.put(1, 'rows', page(0));
  const first = cache.retain(1, 'rows', 0), second = cache.retain(1, 'rows', 0);
  assert.equal(cache.put(1, 'rows', page(100)), null);
  first(); first(); assert.equal(cache.stats.pinned, 1);
  assert.equal(cache.put(1, 'rows', page(100)), null);
  second(); assert.equal(cache.stats.pinned, 0);
  assert(cache.put(1, 'rows', page(100))); assert.equal(find(cache, 0), null);
});

test('documents share one budget, preserve their own keys and release only their own history', () => {
  const cache = new PageCache({ maxEntries: 2 });
  cache.put(1, 'rows', page(0, 'first')); cache.put(2, 'rows', page(0, 'second'));
  assert.equal(find(cache, 0, 1).page.items[0].value, 'first');
  assert.equal(find(cache, 0, 2).page.items[0].value, 'second');
  cache.put(3, 'rows', page(0, 'third')); assert.equal(find(cache, 0, 1), null);
  cache.deleteOwner(2); assert.equal(cache.stats.entries, 1);
  cache.deleteOwner(3); assert.equal(cache.stats.bytes, 0);
});

test('speculative pages use free capacity and do not evict history', () => {
  const cache = new PageCache({ maxEntries: 2 });
  cache.put(1, 'rows', page(0)); cache.put(1, 'rows', page(100));
  assert.equal(cache.put(1, 'rows', page(200), { speculative: true }), null);
  assert(find(cache, 0)); assert(find(cache, 100));
  const disabled = new PageCache({ budget: 0 });
  assert.equal(disabled.put(1, 'rows', page(0)), null); assert.equal(disabled.stats.bytes, 0);
});
