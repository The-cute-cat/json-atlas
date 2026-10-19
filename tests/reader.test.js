import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MAX_FILE_BYTES, PAGE_SIZE, searchData, parseDocument, encodeDataPath, normalizeDataPath } from '../src/data.js';
import { MemoryDataSource } from '../src/data-source.js';
import { normalizeThreshold, needsIndex, IndexedDataSource } from '../src/large-files.js';
import { ViewportWindow } from '../src/viewport-window.js';
import { NodeBudget } from '../src/node-budget.js';

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
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
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

function reader(storage = new Map(), native = {}) {
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
    setTimeout: (callback, delay) => delay === 0 ? setTimeout(callback, 0) : 1, clearTimeout() {},
    desktop: false, connectDesktop: async () => {}, updateWindowTitle() {},
    MAX_FILE_BYTES, PAGE_SIZE, searchData, parseDocument, MemoryDataSource, normalizeThreshold, needsIndex, AbortController, ViewportWindow, NodeBudget,
    encodePath: encodeDataPath, normalizePath: normalizeDataPath,
    console, Blob, ...native
  };
  const api = runInNewContext(pagingSource + '\n' + source + `
    ;({ buildDoc, resolveDoc, activateDoc, collectSession, expandByPaths, expandLevels, expandOne,
      openEditor, relabelArrayIndexes, searchTree, nodeContentText, closeDoc, loadFile, showNodeLimit, collapseAll, updateVirtualization,
      add: doc => docs.push(doc), configure: value => Object.assign(settings, value),
      setTemplate: value => { template = value; }, template: () => template,
      state: () => ({ activeDocId, currentRootLabel, doc: activeDoc(), view: { ...mainView.state } }) });`, context);
  return { api, elements, storage, flush: async () => { while (frames.length) await frames.shift()(); } };
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

test('node cleanup appears on limit, releases old content, and hides after manual collapse or file switch', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc(JSON.stringify(Array.from({ length: 5000 }, (_, i) => i)), 'wide.json', 1);
  api.add(doc); api.activateDoc(doc.id);
  const root = elements.get('tree').firstElementChild;
  await api.expandOne(root);
  assert.equal(elements.get('nodeBudgetNotice').hidden, false);
  const cleanup = elements.get('reclaimNodesBtn').listeners.get('click');
  cleanup();
  assert.equal(elements.get('tree').querySelectorAll('.tree-node').length, 4000);
  assert(root.classList.contains('open'));
  assert.equal(elements.get('nodeBudgetNotice').hidden, true);
  await api.expandOne(root);
  api.collapseAll();
  assert.equal(elements.get('nodeBudgetNotice').hidden, true);
  await api.expandOne(root);
  const other = api.buildDoc('{"ok":1}', 'small.json', 1); api.add(other); api.activateDoc(other.id);
  assert.equal(elements.get('nodeBudgetNotice').hidden, true);
});

test('error panel orders compact secondary and primary actions without the full-width primary class', () => {
  const { api, elements } = reader(); api.configure({ strictJsonl: true });
  const doc = api.buildDoc('{"ok":1}\nbad\n', 'bad.jsonl', 1); api.add(doc); api.activateDoc(doc.id);
  const actions = elements.get('docError').querySelectorAll('.doc-error-actions')[0];
  assert.equal(actions.children[0].textContent, '关闭这份文件');
  assert.equal(actions.children[1].textContent, '关闭严格模式并重试');
  assert.equal(actions.children[1].className, 'doc-error-primary');
});

test('inactive errors and skipped JSONL rows remain marked, including empty files', () => {
  const { api, elements } = reader(); api.configure({ strictJsonl: false });
  const empty = api.buildDoc('', 'empty.jsonl', 0), partial = api.buildDoc('{"ok":1}\nbad\n', 'partial.jsonl', 10), good = api.buildDoc('{}', 'good.json', 2);
  for (const doc of [empty, partial, good]) api.add(doc);
  api.activateDoc(good.id);
  const slots = elements.get('fileRail').querySelectorAll('.file-slot');
  assert(slots[0].classList.contains('error')); assert(!slots[0].classList.contains('active'));
  assert(slots[1].classList.contains('warning'));
  assert.match(slots[1].children[0].title, /已跳过 1 行/);
  api.configure({ strictJsonl: true }); api.activateDoc(good.id);
  assert(elements.get('fileRail').querySelectorAll('.file-slot')[1].classList.contains('error'));
  api.activateDoc(empty.id);
  assert.equal(elements.get('docError').querySelectorAll('.doc-error-actions')[0].children.length, 1);
});

test('a collapsed root preserves its saved pan and zoom instead of applying default expansion', async () => {
  const { api, elements, flush } = reader();
  api.configure({ defaultLevels: 3 });
  const doc = api.buildDoc('{"a":{}}', 'data.json', 8);
  doc.openPaths = [];
  doc.view = { x: 123, y: -45, scale: 1.5 };
  api.add(doc); api.activateDoc(doc.id); await flush();
  assert.equal(elements.get('tree').firstElementChild.classList.contains('open'), false);
  const { view } = api.state();
  assert.equal(view.x, 123);
  assert.equal(view.y, -45);
  assert.equal(view.scale, 1.5);
});

test('switching files restores the second array object and its nested arrays exactly', async () => {
  for(const indexBase of [0, 1]) {
    const { api, elements, flush } = reader();
    api.configure({ indexBase });
    const text = JSON.stringify({ records: [
      { nested: [{ detail: {} }, { detail: {} }] },
      { nested: [{ detail: {} }, { detail: {} }] },
      { nested: [{ detail: {} }, { detail: {} }] }
    ] });
    const first = api.buildDoc(text, 'first.json', text.length);
    const second = api.buildDoc('{}', 'second.json', 2);
    api.add(first); api.add(second); api.activateDoc(first.id); await flush();
    const tree = elements.get('tree');
    const find = path => tree.querySelectorAll('.tree-node').find(n => n.dataset.path === path);
    const wanted = ['$', '$.records', '$.records[1]', '$.records[1].nested', '$.records[1].nested[1]'];
    for(const path of wanted) await api.expandOne(find(path));
    for(let round = 0; round < 2; round++) {
      api.activateDoc(second.id); await flush();
      assert.equal(JSON.stringify(first.openPaths), JSON.stringify(wanted));
      api.activateDoc(first.id); await flush();
      assert.equal(JSON.stringify(tree.querySelectorAll('.tree-node.open').map(n => n.dataset.path)), JSON.stringify(wanted));
      assert.equal(find('$.records[0]').classList.contains('open'), false);
      assert.equal(find('$.records[2]').classList.contains('open'), false);
      assert.equal(find('$.records[1].nested[0]').classList.contains('open'), false);
    }
  }
});

test('switching files restores an expanded object on a later page', async () => {
  const { api, elements, flush } = reader();
  const value = Array.from({ length: 202 }, (_, i) => ({ detail: { id: i } }));
  const text = JSON.stringify(value);
  const first = api.buildDoc(text, 'paged.json', text.length);
  first.source = Object.assign(new MemoryDataSource(first.parsed), { paged: true });
  const second = api.buildDoc('{}', 'second.json', 2);
  api.add(first); api.add(second); api.activateDoc(first.id); await flush();
  const tree = elements.get('tree');
  const find = path => tree.querySelectorAll('.tree-node').find(n => n.dataset.path === path);
  await api.expandOne(find('$'), 101);
  await api.expandOne(find('$[101]'));
  await api.expandOne(find('$[101].detail'));
  api.activateDoc(second.id); await flush();
  api.activateDoc(first.id); await flush();
  assert.equal(!!find('$[0]'), false);
  assert.equal(find('$[101]').classList.contains('open'), true);
  assert.equal(find('$[101].detail').classList.contains('open'), true);
  assert.equal(find('$[100]').classList.contains('open'), false);
});

test('saved sessions retain exact indices and literal object keys across restart', async () => {
  const storage = new Map([['json-atlas_settings_v1', JSON.stringify({ reopenLast: true, restoreSession: true })]]);
  const { api, elements, flush } = reader(storage);
  api.configure({ reopenLast: true, restoreSession: true });
  const text = JSON.stringify({ 'a[12]."': [{ '0': {} }, { '0': {} }] });
  const doc = api.buildDoc(text, 'keys.json', text.length);
  api.add(doc); api.activateDoc(doc.id); await flush();
  const wanted = [[], ['a[12]."'], ['a[12]."', 1], ['a[12]."', 1, '0']].map(encodeDataPath);
  for(const path of wanted) {
    await api.expandOne(elements.get('tree').querySelectorAll('.tree-node').find(n => n.dataset.path === path));
  }
  const session = api.collectSession();
  assert.equal(session.version, 3);
  assert.equal(JSON.stringify(session.docs[`keys.json::${text.length}`].paths), JSON.stringify(wanted));
  storage.set('json-atlas_session_v1', JSON.stringify(session));
  const restarted = reader(storage); await restarted.flush();
  assert.equal(JSON.stringify(restarted.elements.get('tree').querySelectorAll('.tree-node.open').map(n => n.dataset.path)), JSON.stringify(wanted));
});

test('structure templates still normalize array items and expand only the first object', async () => {
  const { api, elements, flush } = reader();
  api.setTemplate({ paths: ['$', '$[0]', '$[0].detail'], hidden: [], savedAt: 1 });
  const doc = api.buildDoc('[{"detail":{}},{"detail":{}}]', 'template.json', 29);
  api.add(doc); api.activateDoc(doc.id); await flush();
  const expanded = elements.get('tree').querySelectorAll('.tree-node.open').map(n => n.dataset.path);
  assert.equal(JSON.stringify(expanded), JSON.stringify(['$', '$[0]', '$[0].detail']));
});

test('JSONL file switching preserves the second record expansion', async () => {
  const { api, elements, flush } = reader();
  const text = '{"detail":{}}\n{"detail":{}}\n';
  const first = api.buildDoc(text, 'records.jsonl', text.length);
  const other = api.buildDoc('{}', 'other.json', 2);
  api.add(first); api.add(other); api.activateDoc(first.id); await flush();
  const tree = elements.get('tree');
  const wanted = ['$', '$[1]', '$[1].detail'];
  for(const path of wanted) await api.expandOne(tree.querySelectorAll('.tree-node').find(n => n.dataset.path === path));
  api.activateDoc(other.id); await flush();
  api.activateDoc(first.id); await flush();
  assert.equal(JSON.stringify(tree.querySelectorAll('.tree-node.open').map(n => n.dataset.path)), JSON.stringify(wanted));
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

test('default expansion and template restoration both bound wide trees', async () => {
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
    if (mode === 'default') await api.expandLevels(elements.get('tree').firstElementChild, 3);
    else await api.expandByPaths(['$', ...Object.keys(value).map(key => '$.' + key)]);
    const count = tree.querySelectorAll('.tree-node').length;
    assert(count >= 5000 && count <= 5100, `${mode}: ${count}`);
  }
});

const nodeKeys = scope => [...scope.querySelectorAll('.tree-node')].map(node => node._key);

test('changing the array index base relabels editor array items instead of throwing', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('[{"a":1}]', 'list.json', 10);
  api.add(doc); api.activateDoc(doc.id);
  api.openEditor();

  const editorTree = elements.get('editorTree');
  const root = editorTree.firstElementChild;
  await root._ensureChildren();   // 编辑器里数组只挂载第一项
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

test('clearing the template rebuilds the tree so hidden fields come back', async () => {
  const { api, elements } = reader();
  api.setTemplate({ paths: ['$'], hidden: ['$.secret'], file: 'data.json', savedAt: 1 });
  const doc = api.buildDoc('{"secret":1,"keep":2}', 'data.json', 20);
  api.add(doc); api.activateDoc(doc.id);

  const tree = elements.get('tree');
  await tree.firstElementChild._ensureChildren();
  assert.equal(nodeKeys(tree).includes('secret'), false);
  assert.equal(nodeKeys(tree).includes('keep'), true);

  elements.get('clearTemplateBtn').listeners.get('click')();
  await tree.firstElementChild._ensureChildren();
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

test('reader renders branch metadata and reads full content through its source', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('{"a":{"b":1}}', 'data.json', 13);
  api.add(doc); api.activateDoc(doc.id);
  const root = elements.get('tree').firstElementChild;
  assert.equal(root._value, undefined);
  assert.equal(root._childrenType, 'object');
  assert.equal(await api.nodeContentText(root), '{\n  "a": {\n    "b": 1\n  }\n}');
  await root._ensureChildren();
  const child = root.children.find(n => n.classList.contains('children')).firstElementChild;
  assert.equal(child._value, undefined);
  assert.equal(child._childrenType, 'object');
  assert.equal(await api.nodeContentText(child), '{\n  "b": 1\n}');
});

test('search waits for unloaded ancestor pages before selecting a match', async () => {
  const { api, elements } = reader();
  const text = JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ content: `record-${i}` })));
  const doc = api.buildDoc(text, 'list.json', text.length);
  api.add(doc); api.activateDoc(doc.id);
  await api.searchTree('record-200');
  const selected = elements.get('tree').querySelectorAll('.current-match');
  assert.equal(selected.length, 1);
  assert.equal(JSON.stringify(selected[0]._path), '[200,"content"]');
  assert.equal(elements.get('searchCount').textContent, '1 / 1');
});

test('closing the last document cancels branch loads and disposes its source', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('[1,2]', 'data.json', 5);
  api.add(doc); api.activateDoc(doc.id);
  const root = elements.get('tree').firstElementChild;
  const pending = root._ensureChildren();
  const source = doc.source;
  api.closeDoc(doc.id);
  assert.equal(await pending, false);
  await assert.rejects(source.getChildren([]), /关闭/);
  assert.equal(elements.get('tree').children.length, 0);
});

test('a slow expansion cannot refill the tree after switching documents', async () => {
  const { api, elements } = reader();
  const first = api.buildDoc('{"old":1}', 'old.json', 9);
  const second = api.buildDoc('{"new":2}', 'new.json', 9);
  api.add(first); api.add(second); api.activateDoc(first.id);
  const oldRoot = elements.get('tree').firstElementChild;
  let release;
  first.source.getChildren = () => new Promise(resolve => { release = resolve; });
  const expansion = api.expandLevels(oldRoot, 2);
  await new Promise(resolve => setImmediate(resolve));
  api.activateDoc(second.id);
  release({ start: 0, end: 1, total: 1, items: [
    { key: 'old', path: ['old'], type: 'number', childCount: 0, value: 1 }
  ] });
  await expansion;
  const tree = elements.get('tree');
  await tree.firstElementChild._ensureChildren();
  assert.equal(nodeKeys(tree).includes('old'), false);
  assert.equal(nodeKeys(tree).includes('new'), true);
});

test('native opening chooses disk indexing above threshold and keeps that source through rendering', async () => {
  const memory = new MemoryDataSource({ value: 42 });
  const info = { root: memory.getRoot(), kind: 'json', records: 0, badCount: 0, commentCount: 0 };
  const calls = [];
  const indexed = new IndexedDataSource(async (op, id, args) => {
    calls.push(op);
    if (op === 'page') return memory.getChildren(args.path, args);
    if (op === 'text') return memory.getText(args.path);
  }, 'native-test', info);
  const { api, elements } = reader(new Map(), {
    statNativeFile: async path => ({ path, name: 'large.json', size: 33 * 1024 ** 2 }),
    readNativeFile: () => { throw new Error('must not read the complete file'); },
    openIndexedFile: async (metadata, options) => { options.progress(metadata.size / 2); return indexed; }
  });
  api.configure({ largeFileThresholdMiB: 32 });
  await api.loadFile({ path: 'D:/large.json' });
  const doc = api.state().doc;
  assert.equal(doc.source, indexed); assert.equal(doc.parsed, undefined); assert.equal(doc.text, '');
  assert(doc.sub.includes('索引模式'));
  await elements.get('tree').firstElementChild._ensureChildren();
  assert(nodeKeys(elements.get('tree')).includes('value'));
  assert.equal(elements.get('loadingStatus').hidden, true);
  api.closeDoc(doc.id); assert.equal(calls.at(-1), 'close');
});

test('native opening at the threshold retains the ordinary worker parser', async () => {
  let read = 0;
  const { api } = reader(new Map(), {
    URL,
    Worker: class {
      terminate() {}
      postMessage(payload) { this.onmessage({ data: { result: parseDocument(payload.text, payload.name), text: '' } }); }
    },
    statNativeFile: async path => ({ path, name: 'normal.json', size: 32 * 1024 ** 2 }),
    readNativeFile: async path => { read++; return { path, name: 'normal.json', size: 32 * 1024 ** 2, text: '{"ok":true}' }; },
    openIndexedFile: () => { throw new Error('must not index at the threshold'); }
  });
  api.configure({ largeFileThresholdMiB: 32 });
  await api.loadFile({ path: 'D:/normal.json' });
  assert.equal(read, 1); assert.equal(api.state().doc.parsed.ok, true);
});

test('reading action labels follow the active file mode and small files have no paging controls', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc(JSON.stringify(Array.from({length:201},(_,i)=>i)), 'small.json', 800);
  api.add(doc); api.activateDoc(doc.id);
  await elements.get('tree').firstElementChild._ensureChildren();
  assert.equal(elements.get('expandAllBtn').textContent, '展开全部');
  assert.equal(elements.get('ctxExpandSubtree').textContent, '展开全部下级');
  assert.equal(elements.get('tree').querySelectorAll('.page-navigation').length, 0);
  const large = api.buildDoc('[]', 'large.json', 65000000);
  large.source = new IndexedDataSource(async()=>{},'labels',{root:{path:[],type:'array',childCount:0},kind:'json'});
  api.add(large); api.activateDoc(large.id);
  assert.equal(elements.get('expandAllBtn').textContent, '展开当前页');
  api.activateDoc(doc.id); assert.equal(elements.get('editorExpandAllBtn').textContent, '展开全部');
});

test('cancelling an index load leaves the current document active and hides the loading indicator', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { api, elements } = reader(new Map(), {
    statNativeFile: async path => ({ path, name: 'large.json', size: 65 * 1024 ** 2 }),
    openIndexedFile: async (metadata, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
    })
  });
  const old = api.buildDoc('[1]', 'old.json', 3); api.add(old); api.activateDoc(old.id);
  const pending = api.loadFile({ path: 'D:/large.json' }); await ready;
  assert.equal(elements.get('loadingStatus').hidden, false);
  elements.get('cancelLoadBtn').listeners.get('click')(); await pending;
  assert.equal(api.state().activeDocId, old.id); assert.equal(elements.get('loadingStatus').hidden, true);
});

test('threshold select saves the chosen size and reopens at the persisted value', () => {
  const { elements, storage } = reader();
  const select = elements.get('optLargeFileThreshold'); select.value = '128';
  select.listeners.get('change')();
  const saved = [...storage.values()].map(s => JSON.parse(s)).find(v => v.largeFileThresholdMiB);
  assert.equal(saved.largeFileThresholdMiB, 128);
  const restored = reader(storage); restored.elements.get('settingsBtn').listeners.get('click')();
  assert.equal(restored.elements.get('optLargeFileThreshold').value, '128');
});
