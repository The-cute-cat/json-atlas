import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSearch } from '../src/search-pattern.js';
import { searchData } from '../src/data.js';

test('literal matching keeps default case folding and treats regexp characters literally', () => {
  assert(compileSearch('CAT').test('cat'));
  assert(!compileSearch('CAT', { caseSensitive: true }).test('cat'));
  assert(compileSearch('.*').test('literal .*'));
  assert(!compileSearch('.*').test('anything'));
  assert(compileSearch('i̇').test('İ'));
});
test('whole words have Unicode boundaries and respect case sensitivity', () => {
  const word = compileSearch('cat', { wholeWord: true });
  for (const value of ['cat', 'a cat!', 'CAT']) assert(word.test(value));
  for (const value of ['catalog', 'a_cat', 'cat2', '汉cat']) assert(!word.test(value));
  assert(compileSearch('汉字', { wholeWord: true }).test('汉字！'));
  assert(!compileSearch('汉字', { wholeWord: true }).test('汉字库'));
});
test('regular expressions support groups, classes, anchors, and whole-match boundaries', () => {
  const re = compileSearch('user-\\d{2}(?:-ok)?$', { regex: true });
  assert(re.test('key USER-42-ok')); assert(!re.test('user-2'));
  assert(compileSearch('cat|dog', { regex: true, wholeWord: true }).test('a dog!'));
  assert(!compileSearch('cat|dog', { regex: true, wholeWord: true }).test('catalog'));
  for (const query of ['[', '(?=a)', '(?<=a)b', '(a)\\1']) assert.throws(() => compileSearch(query, { regex: true }), /正则/);
});
test('advanced search preserves hidden paths, index labels, and DFS limits', async () => {
  const value = [{ text: 'Cat', hidden: 'cat' }, { text: 'catalog' }, { text: 'cat' }];
  assert.deepEqual((await searchData(value, 'cat', { wholeWord: true, hidden: new Set(['$[0].hidden']) })).hits, [[0, 'text'], [2, 'text']]);
  assert.deepEqual((await searchData(value, 'Cat', { caseSensitive: true })).hits, [[0, 'text']]);
  assert.deepEqual(await searchData(value, '^3 ', { regex: true, indexBase: 1, limit: 1 }), { hits: [[2]], truncated: true });
});

test('scoped matching excludes ancestors and siblings and keeps exact result paths', async () => {
  const value = { outside: 'cat', rows: [{ text: 'cat' }, { text: 'CAT' }] };
  assert.deepEqual((await searchData(value, 'cat', { scopePath: ['rows', 1] })).hits, [['rows', 1, 'text']]);
  assert.deepEqual((await searchData(value, 'cat', { scopePath: ['rows', 1], hidden: new Set(['$.rows']) })).hits, []);
  assert.deepEqual((await searchData(value, '^2 ', { scopePath: ['rows', 1], regex: true, indexBase: 1 })).hits, [['rows', 1]]);
});
