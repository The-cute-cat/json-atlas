import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDataSource } from '../src/data-source.js';

test('source supplies metadata and only one requested page, without recursive branch values', async () => {
  const source = new MemoryDataSource(Array.from({ length: 10001 }, (_, id) => ({ id })));
  assert.deepEqual(source.getRoot(), { path: [], type: 'array', childCount: 10001 });
  const page = await source.getChildren([], { key: 10000 });
  assert.equal(page.start, 10000);
  assert.equal(page.total, 10001);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0], { path: [10000], key: 10000, arrayItem: true, type: 'object', childCount: 1 });
  assert.equal((await source.getChildren([10000])).items[0].value, 10000);
});

test('source preserves object-key order, special keys, empty containers and primitive roots', async () => {
  const value = JSON.parse('{"0":null,"01":false,"a[12]":"","__proto__":{"safe":1}}');
  const source = new MemoryDataSource(value);
  assert.deepEqual((await source.getChildren([])).items.map(n => n.key), Object.keys(value));
  assert.equal((await source.getChildren([], { key: '__proto__' })).items.at(-1).type, 'object');
  assert.equal((await source.getChildren(['__proto__'])).items[0].value, 1);
  await assert.rejects(source.getChildren(['constructor']), /节点不存在/);
  for (const primitive of [null, false, 0, '']) {
    const source = new MemoryDataSource(primitive);
    assert.equal(source.getRoot().value, primitive);
    assert.equal((await source.getChildren([])).total, 0);
    assert.equal(await source.getText([]), String(primitive));
  }
  assert.equal((await new MemoryDataSource([]).getChildren([])).items.length, 0);
});

test('source search reaches unmounted pages and retains hidden-field and index-base behavior', async () => {
  const source = new MemoryDataSource(Array.from({ length: 201 }, (_, id) => ({ content: `record-${id}`, secret: 'hide' })));
  assert.deepEqual((await source.search('record-200')).hits, [[200, 'content']]);
  assert.deepEqual((await source.search('hide', { hidden: new Set(['$[0].secret']) })).hits, []);
  assert.deepEqual((await new MemoryDataSource(['value']).search('1 value', { indexBase: 1 })).hits, [[0]]);
});

test('full text preserves raw strings and formatting, disposal and abort reject new requests', async () => {
  const source = new MemoryDataSource({ text: '{"nested":true}', array: [false, null] });
  assert.equal(await source.getText(['text']), '{"nested":true}');
  assert.equal(await source.getText(['array']), '[\n  false,\n  null\n]');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getChildren([], { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(source.getChildren([], { limit: 10000 }), /分页/);
  source.dispose();
  assert.throws(() => source.getRoot(), /关闭/);
  await assert.rejects(source.getText([]), /关闭/);
  await assert.rejects(source.search('anything'), /关闭/);
});

test('closing a source cancels a search already scanning it', async () => {
  const source = new MemoryDataSource(Array.from({ length: 5000 }, (_, id) => ({ id })));
  assert.equal(await source.search('absent', { yieldTask: async () => source.dispose() }), null);
});
