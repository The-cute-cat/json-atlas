import test from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, initializeLanguage, msg, nativeErrorMessage, normalizeLanguage, saveLanguage, setLanguage, t } from '../src/i18n.js';
import { parseDocument } from '../src/data.js';

test('English translates interface messages and parser diagnostics while preserving document data', () => {
  assert.equal(normalizeLanguage('unsupported'), 'en');
  assert.equal(getLanguage(), 'en');
  try {
    assert.equal(t('打开文件'), 'Open file');
    const filename = '设置.json';
    assert.equal(msg`已关闭 ${filename}`, 'Closed 设置.json');
    assert.match(parseDocument('{"broken":}', 'broken.json').error, /^JSON parsing failed:/);
    assert.deepEqual(parseDocument('{"设置":"打开文件"}', filename).parsed, { 设置: '打开文件' });
  } finally {
    setLanguage('en');
  }
});

test('native errors use their English message by default and select Chinese when available', () => {
  const error = {
    message: 'Byte 42: invalid JSON value',
    messageZhCn: '字节 42：无效的 JSON 值'
  };
  assert.equal(nativeErrorMessage(error), error.message);
  setLanguage('zh-CN');
  try {
    assert.equal(nativeErrorMessage(error), error.messageZhCn);
    assert.equal(nativeErrorMessage({ message: 'New native error' }), 'New native error');
    assert.equal(nativeErrorMessage(new Error('IPC unavailable')), 'IPC unavailable');
    assert.equal(nativeErrorMessage('Command not found'), 'Command not found');
  } finally {
    setLanguage('en');
  }
});

test('saved interface language is applied before reading user data', () => {
  const stored = new Map();
  const storage = {
    getItem: key => stored.get(key),
    setItem: (key, value) => stored.set(key, value)
  };
  const text = { nodeValue: ' 打开文件 ', parentElement: { closest: () => null } };
  const attributes = new Map([['placeholder', '搜索键名或值…']]);
  const element = {
    hasAttribute: key => attributes.has(key),
    getAttribute: key => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value)
  };
  const document = {
    documentElement: {},
    createTreeWalker() {
      const nodes = [text].values();
      return { nextNode: () => nodes.next().value };
    },
    querySelectorAll: () => [element]
  };
  try {
    initializeLanguage(document, storage, { languages: ['zh-SG'] });
    assert.equal(document.documentElement.lang, 'zh-CN');
    assert.equal(text.nodeValue, ' 打开文件 ');
    assert.equal(saveLanguage('en', storage), true);
    assert.equal(document.documentElement.lang, 'zh-CN');

    initializeLanguage(document, storage, { languages: ['zh-SG'] });
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(text.nodeValue, ' Open file ');
    assert.equal(attributes.get('placeholder'), 'Search keys or values…');
  } finally {
    setLanguage('en');
  }
});

test('first launch uses the first supported system language and saves it for later launches', () => {
  const cases = [
    [{ languages: ['fr-FR', 'zh-Hans-CN', 'en-GB'] }, 'zh-CN'],
    [{ languages: ['en-GB', 'zh-CN'] }, 'en'],
    [{ languages: ['zh-TW', 'ja-JP'] }, 'en'],
    [{ languages: ['invalid_tag', 'zh-Hans'] }, 'zh-CN'],
    [{ languages: [], language: 'zh-CN' }, 'zh-CN'],
    [{}, 'en']
  ];
  const document = {
    documentElement: {},
    createTreeWalker: () => ({ nextNode: () => null }),
    querySelectorAll: () => []
  };
  try {
    for (const [localeSource, expected] of cases) {
      let stored = null;
      const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
      initializeLanguage(document, storage, localeSource);
      assert.equal(document.documentElement.lang, expected);
      assert.equal(stored, expected);
      initializeLanguage(document, storage, { languages: [expected === 'en' ? 'zh-CN' : 'en'] });
      assert.equal(document.documentElement.lang, expected);
    }
    const unavailable = { getItem() { throw new Error('Storage unavailable'); } };
    initializeLanguage(document, unavailable, { language: 'zh-CN' });
    assert.equal(document.documentElement.lang, 'zh-CN');
  } finally {
    setLanguage('en');
  }
});
