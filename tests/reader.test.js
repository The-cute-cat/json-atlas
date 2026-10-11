import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAX_FILE_BYTES, PAGE_SIZE, searchData, parseDocument, encodeDataPath, normalizeDataPath } from '../src/data.js';

// A small DOM harness for reader state transitions; this does not test layout/WebView2.
class Element {
  children = [];
  dataset = {};
  className = '';
  value = '';
  listeners = new Map();
  style = { setProperty() {} };
  classList = {
    contains: name => this.className.split(' ').includes(name),
    add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
    remove: (...names) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' '); },
    toggle: (name, force) => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name); else this.classList.remove(name);
      return on;
    }
  };
  get firstElementChild() { return this.children[0] || null; }
  set innerHTML(value) { this.replaceChildren(); this.textContent = value; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren() { this.children.forEach(child => { child.parentElement = null; }); this.children = []; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute() {}
  querySelectorAll(selector) {
    const result = [];
    const groups = selector.split(',').map(s => s.trim().split('.').filter(Boolean));
    const matches = el => groups.some(names => names.every(name => el.classList.contains(name)));
    const pending = [...this.children].reverse();
    while (pending.length) {
      const child = pending.pop();
      if (matches(child)) result.push(child);
      pending.push(...child.children.toReversed());
    }
    return result;
  }
}

const source = readFileSync(new URL('../src/reader.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replaceAll('import.meta.url', '"file:///reader.js"');
const pagingSource = readFileSync(new URL('../src/paging.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function');

function reader(storage = new Map()) {
  const elements = new Map();
  const frames = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement: () => new Element(),
    addEventListener() {}
  };
  const context = {
    document, window: { addEventListener() {} }, navigator: { platform: 'Win32' },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    requestAnimationFrame: callback => frames.push(callback),
    setTimeout: () => 1, clearTimeout() {},
    desktop: false, connectDesktop: async () => {}, updateWindowTitle() {},
    MAX_FILE_BYTES, PAGE_SIZE, searchData, parseDocument,
    encodePath: encodeDataPath, normalizePath: normalizeDataPath,
    console, Blob
  };
  const api = runInNewContext(pagingSource + '\n' + source + `
    ;({ buildDoc, resolveDoc, activateDoc, collectSession, expandByPaths, expandLevels,
      openEditor, relabelArrayIndexes,
      add: doc => docs.push(doc), configure: value => Object.assign(settings, value),
      setTemplate: value => { template = value; }, template: () => template,
      state: () => ({ activeDocId, currentRootLabel, view: { ...mainView.state } }) });`, context);
  return { api, elements, storage, flush: () => { while (frames.length) frames.shift()(); } };
}

test('switching files persists the selected document even with session restoration disabled', () => {
  const { api, storage } = reader();
  api.configure({ reopenLast: true, restoreSession: false });
  const first = api.buildDoc('{"a":1}', 'first.json', 7);
  const second = api.buildDoc('{"b":2}', 'second.json', 7);
  api.add(first); api.add(second);
  api.activateDoc(second.id);
  api.activateDoc(first.id);
  assert.equal(JSON.parse(storage.get('json-atlas_lastfile_v1')).activeKey, 'first.json::7');
});

test('a collapsed root preserves its saved pan and zoom instead of applying default expansion', () => {
  const { api, elements, flush } = reader();
  api.configure({ defaultLevels: 3 });
  const doc = api.buildDoc('{"a":{}}', 'data.json', 8);
  doc.openPaths = [];
  doc.view = { x: 123, y: -45, scale: 1.5 };
  api.add(doc); api.activateDoc(doc.id); flush();
  assert.equal(elements.get('tree').firstElementChild.classList.contains('open'), false);
  const { view } = api.state();
  assert.equal(view.x, 123);
  assert.equal(view.y, -45);
  assert.equal(view.scale, 1.5);
});

test('JSON roots do not inherit a stale JSONL record-count label', () => {
  const { api } = reader();
  const doc = api.buildDoc('{"a":1}', 'data.json', 7);
  doc.rootLabel = '100 条记录';
  assert.equal(api.resolveDoc(doc).rootLabel, 'root');
});

test('web startup restores JSONL errors with the same parser used when opening files', () => {
  const storage = new Map([
    ['json-atlas_settings_v1', JSON.stringify({ reopenLast: true, strictJsonl: true })],
    ['json-atlas_lastfile_v1', JSON.stringify({ docs: [
      { name: 'data.jsonl', size: 20, text: '{"a":1}\ninvalid', kind: 'jsonl' }
    ] })]
  ]);
  const { elements } = reader(storage);
  assert.equal(elements.get('docError').classList.contains('show'), true);
});

test('default expansion and template restoration both bound wide trees', () => {
  for (const mode of ['default', 'template']) {
    const { api, elements } = reader();
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, i) =>
      [`branch${i}`, Object.fromEntries(Array.from({ length: 100 }, (_, j) => [`item${j}`, {}]))]));
    const text = JSON.stringify(value);
    const doc = api.buildDoc(text, 'wide.json', text.length);
    api.add(doc); api.activateDoc(doc.id);
    // Model an already large mounted tree so the guard is exercised without
    // repeatedly scanning thousands of test-double elements on each expansion.
    const tree = elements.get('tree');
    const query = tree.querySelectorAll.bind(tree);
    tree.querySelectorAll = selector => {
      const found = query(selector);
      return selector === '.tree-node' ? { length: 4800 + found.length } : found;
    };
    if (mode === 'default') api.expandLevels(elements.get('tree').firstElementChild, 3);
    else api.expandByPaths(['$', ...Object.keys(value).map(key => '$.' + key)]);
    const count = tree.querySelectorAll('.tree-node').length;
    assert(count >= 5000 && count <= 5100, `${mode}: ${count}`);
  }
});

const nodeKeys = scope => [...scope.querySelectorAll('.tree-node')].map(node => node._key);

test('changing the array index base relabels editor array items instead of throwing', () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('[{"a":1}]', 'list.json', 10);
  api.add(doc); api.activateDoc(doc.id);
  api.openEditor();

  const editorTree = elements.get('editorTree');
  const root = editorTree.firstElementChild;
  root._ensureChildren();   // 编辑器里数组只挂载第一项
  const item = [...root.children].find(el => el.classList.contains('children')).children[0];
  assert.equal(item._isArrayItem, true);

  assert.doesNotThrow(() => api.relabelArrayIndexes(editorTree));
  assert.equal(item._key, '0');
  api.configure({ indexBase: 1 });
  api.relabelArrayIndexes(editorTree);
  assert.equal(item._key, '1');
});

test('a document whose root value is null can still open the template editor', () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('null', 'null.json', 4);
  api.add(doc); api.activateDoc(doc.id);
  api.openEditor();
  assert.equal(elements.get('editorMask').classList.contains('open'), true);
});

test('clearing the template rebuilds the tree so hidden fields come back', () => {
  const { api, elements } = reader();
  api.setTemplate({ paths: ['$'], hidden: ['$.secret'], file: 'data.json', savedAt: 1 });
  const doc = api.buildDoc('{"secret":1,"keep":2}', 'data.json', 20);
  api.add(doc); api.activateDoc(doc.id);

  const tree = elements.get('tree');
  tree.firstElementChild._ensureChildren();
  assert.equal(nodeKeys(tree).includes('secret'), false);
  assert.equal(nodeKeys(tree).includes('keep'), true);

  elements.get('clearTemplateBtn').listeners.get('click')();
  tree.firstElementChild._ensureChildren();
  assert.equal(nodeKeys(tree).includes('secret'), true);
});

test('recording the current expansion keeps the hidden-field configuration', () => {
  const { api, elements } = reader();
  api.setTemplate({ paths: ['$'], hidden: ['$.secret'], file: 'data.json', savedAt: 1 });
  const doc = api.buildDoc('{"a":{"b":1}}', 'data.json', 10);
  api.add(doc); api.activateDoc(doc.id);

  elements.get('tree').firstElementChild.classList.add('open');
  elements.get('recordTemplateBtn').listeners.get('click')();

  assert.deepEqual(api.template().hidden, ['$.secret']);
  assert(api.template().paths.includes('$'));
});
