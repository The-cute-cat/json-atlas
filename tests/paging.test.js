import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MemoryDataSource } from '../src/data-source.js';
import { PAGE_SIZE } from '../src/data.js';
import { IndexedDataSource } from '../src/large-files.js';
import { PageCache } from '../src/page-cache.js';

class Element {
  children = [];
  attributes = {};
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
const sourceText = readFileSync(new URL('../src/paging.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function');
const { pagedChildren, discardPagedTree } = runInNewContext(sourceText + '\n;({pagedChildren, discardPagedTree})', {
  PAGE_SIZE, AbortController, setTimeout, document: { createElement: () => new Element() }
});
const settle = () => new Promise(resolve => setImmediate(resolve));
const event = { stopPropagation() {} };
function mount(source, firstArrayOnly = false) {
  const node = new Element(), container = new Element();
  node.appendChild(container);
  pagedChildren(node, container, source, [], item => Object.assign(new Element(), { item }), () => {}, firstArrayOnly);
  return { node, container, items: () => container.children.filter(child => child.item).map(child => child.item) };
}

test('object and array navigation loads pages by offset, including the final page', async () => {
  for (const value of [Array.from({ length: 201 }, (_, i) => i), Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`key${i}`, i]))]) {
    const { node, container, items } = mount(Object.assign(new MemoryDataSource(value), {paged:true}));
    assert(await node._ensureChildren());
    assert.equal(items().length, 100);
    container.children.at(-1).children[2].onclick(event);
    await settle();
    assert.equal(items()[0].value, 100);
    container.children.at(-1).children[2].onclick(event);
    await settle();
    assert.equal(items().length, 1);
    assert.equal(items()[0].value, 200);
    container.children.at(-1).children[0].onclick(event);
    await settle();
    assert.equal(items()[0].value, 100);
  }
});

test('template editor requests only the first array element', async () => {
  const { node, container, items } = mount(new MemoryDataSource([{}, {}, {}]), true);
  await node._ensureChildren();
  assert.equal(items().length, 1);
  assert.equal(items()[0].key, 0);
  assert.equal(container.children.length, 1);
});

test('memory documents expose all ordinary children without page navigation', async () => {
  const { node, container, items } = mount(new MemoryDataSource(Array.from({length:301},(_,i)=>i)));
  await node._ensureChildren(); assert.equal(items().length, 301);
  assert.equal(container.children.some(n => n.className === 'page-navigation'), false);
});

test('a very wide memory branch keeps the display guard and search can reach later items', async () => {
  const { node, container, items } = mount(new MemoryDataSource(Array.from({length:5005},(_,i)=>i)));
  await node._ensureChildren(); assert.equal(items().length, 5000);
  assert.equal(container.children.at(-1).className, 'node-limit');
  await node._ensureChildren(5004); assert.equal(items().at(-1).key, 5004);
  assert.equal(container.children.some(n => n.className === 'page-navigation'), false);
});

test('late responses cannot repopulate a collapsed branch, even if the source ignores abort', async () => {
  let resolve;
  const { node, container } = mount({ getChildren: () => new Promise(r => { resolve = r; }) });
  const pending = node._ensureChildren();
  await settle();
  node._discardChildren();
  resolve({ start: 0, end: 1, total: 1, items: [{ key: 0 }] });
  assert.equal(await pending, false);
  assert.equal(container.children.length, 0);
  assert.equal(node.attributes['aria-busy'], 'false');
});

test('only the newest requested page is committed when results arrive out of order', async () => {
  const requests = [];
  const { node, items } = mount({ getChildren: (_path, options) => new Promise(resolve => requests.push({ options, resolve })) });
  const old = node._ensureChildren(0);
  await settle();
  const latest = node._ensureChildren(100);
  await settle();
  requests[1].resolve({ start: 100, end: 101, total: 201, items: [{ key: 100 }] });
  assert(await latest);
  requests[0].resolve({ start: 0, end: 1, total: 201, items: [{ key: 0 }] });
  assert.equal(await old, false);
  assert.equal(items()[0].key, 100);
});

test('discarding a tree cancels requests in descendant branches', async () => {
  let resolve;
  const parent = new Element();
  const { node, container } = mount({ getChildren: () => new Promise(r => { resolve = r; }) });
  parent.appendChild(node);
  const pending = node._ensureChildren();
  await settle();
  discardPagedTree(parent);
  resolve({ start: 0, end: 1, total: 1, items: [{ key: 0 }] });
  assert.equal(await pending, false);
  assert.equal(container.children.filter(child => child.item).length, 0);
  assert.equal(node.attributes['aria-busy'], 'false');
});

test('failed loads can be retried and do not leave a branch permanently busy', async () => {
  let fail = true;
  const memory = new MemoryDataSource([42]);
  const { node, container, items } = mount({ getChildren: (...args) => fail ? Promise.reject(new Error('test read error')) : memory.getChildren(...args) });
  assert.equal(await node._ensureChildren(), false);
  assert.equal(node.attributes['aria-busy'], 'false');
  assert.match(container.children[0].textContent, /test read error/);
  fail = false;
  container.children[0].children[0].onclick(event);
  await settle();
  assert.equal(items()[0].value, 42);
  assert.equal(node._pageError, null);
});

test('mounted pages retain cache leases and release them on page change and subtree discard', async () => {
  const memory = new MemoryDataSource(Array.from({ length: 205 }, (_, i) => i));
  const cache = new PageCache({ maxEntries: 2 });
  const source = new IndexedDataSource(async (op, id, args) => {
    if (op === 'page') return memory.getChildren(args.path, args);
  }, 'paging', { root: memory.getRoot() }, true, { cache });
  const { node, container, items } = mount(source);
  await node._ensureChildren(); await settle(); assert.equal(cache.stats.pinned, 1);
  node._setPageRetained(false); assert.equal(cache.stats.pinned, 0);
  node._setPageRetained(true); assert.equal(cache.stats.pinned, 1);
  container.children.at(-1).children[2].onclick(event); await settle();
  assert.equal(items()[0].value, 100); assert.equal(cache.stats.pinned, 1);
  discardPagedTree(node); assert.equal(cache.stats.pinned, 0);
  node._discardChildren(); assert.equal(cache.stats.pinned, 0);
  source.dispose(); assert.equal(cache.stats.bytes, 0);
});
