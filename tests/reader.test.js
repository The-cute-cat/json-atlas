import { valueAt, replaceValue, editObjectTopic, parseEdit, serializeDocument } from '../src/editing.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
import { MAX_FILE_BYTES, MAX_RENDERED_CHILDREN, PAGE_SIZE, searchData, parseDocument, encodeDataPath, normalizeDataPath } from '../src/data.js';
import { MemoryDataSource } from '../src/data-source.js';
import { sharedPageCache } from '../src/page-cache.js';
import { normalizeThreshold, needsIndex, IndexedDataSource } from '../src/large-files.js';
import { ViewportWindow } from '../src/viewport-window.js';
import { NodeBudget } from '../src/node-budget.js';
import { compileSearch } from '../src/search-pattern.js';
import { ideModel, renderIde, normalizeViewMode, parseIdeText, formatIdeText, ideTextLines, ideProjection, ideRawOffset, ideProjectedEdit } from '../src/ide-view.js';
import { normalizeTheme, watchTheme } from '../src/theme.js';
import { installTooltips } from '../src/tooltips.js';
import { isMacPlatform, shortcutLabel, shortcutAction, shortcutAlternativeLabel } from '../src/shortcuts.js';

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
  appendChild(child) { if(child.parentElement) child.remove(); this.children.push(child); child.parentElement = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.append(...children); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute() {}
  removeAttribute() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
  remove() { if(this.parentElement) this.parentElement.children = this.parentElement.children.filter(child=>child!==this); this.parentElement=null; }
  focus() {}
  select() {}
  click() { if(!this.disabled) this.listeners.get('click')?.({target:this}); }
  setSelectionRange(start,end,direction){ Object.assign(this,{selectionStart:start,selectionEnd:end,selectionDirection:direction}); }
  setPointerCapture() {}
  getBoundingClientRect() { return { width: 610, height: 102, bottom: 54 }; }
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
  const keyListeners = new Map();
  let toolbarBottom = 54;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, new Element());
        if(id === 'findPanel') elements.get(id).hidden = true;
      }
      return elements.get(id);
    },
    createElement: () => new Element(),
    createTextNode: text => Object.assign(new Element(), {textContent:text}),
    addEventListener(name, listener) { keyListeners.set(name, listener); },
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: toolbarBottom }) })
  };
  const context = {
    document, window: { innerWidth: 1440, innerHeight: 900, addEventListener() {} }, navigator: { platform: 'Win32' },
    localStorage: {
      get length() { return storage.size; },
      key: index => [...storage.keys()][index] ?? null,
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    requestAnimationFrame: callback => frames.push(callback),
    setTimeout: (callback, delay) => delay === 0 ? setTimeout(callback, 0) : 1, clearTimeout() {},
    desktop: false, connectDesktop: async () => {}, updateWindowTitle() {}, updateWindowTheme() {},
    MAX_FILE_BYTES, MAX_RENDERED_CHILDREN, PAGE_SIZE, searchData, parseDocument, MemoryDataSource, sharedPageCache, normalizeThreshold, needsIndex, AbortController, ViewportWindow, NodeBudget,
    valueAt, replaceValue, editObjectTopic, parseEdit, serializeDocument, ideModel, renderIde, normalizeViewMode, parseIdeText, formatIdeText, ideTextLines, ideProjection, ideRawOffset, ideProjectedEdit, normalizeTheme, watchTheme,
    encodePath: encodeDataPath, normalizePath: normalizeDataPath, compileSearch,
    console, Blob, File, manifest, isMacPlatform, shortcutLabel, shortcutAction, shortcutAlternativeLabel, installTooltips, ...native
  };
  const api = runInNewContext(pagingSource + '\n' + source + `
    ;({ buildDoc, resolveDoc, activateDoc, collectSession, saveSession, expandByPaths, expandLevels, expandOne, positionFindPanel,
      beginNodeEdit, applyNodeEdit, applyIdeChange, toggleIdeFold, handleIdeInput, formatIde, openEditor, relabelArrayIndexes, searchTree, nodeContentText, closeDoc, loadFile, openPaths, showNodeLimit, collapseAll, updateVirtualization, saveCurrentDocument,
      openPastedText, selectCopyNode, releaseIdleDocuments,
      allDocs: () => docs,
      add: doc => docs.push(doc), configure: value => Object.assign(settings, value),
      setTemplate: value => { template = value; }, template: () => template,
      state: () => ({ activeDocId, currentRootLabel, doc: activeDoc(), view: { ...mainView.state } }) });`, context);
  return { api, elements, storage, keyListeners, window: context.window, setToolbarBottom: value => {toolbarBottom=value;}, flush: async () => { while (frames.length) await frames.shift()(); } };
}

test('desktop settings export uses the save dialog and handles cancellation and errors', async () => {
  const calls = [];
  let destination = null;
  const {api,elements} = reader(new Map(), {
    desktop:true, updateDocumentMenu(){}, guardEditedClose:async()=>{},
    saveDocumentCopy:async (name,text,originalPath,protectedPaths) => {
      calls.push({name, payload:JSON.parse(text), originalPath, protectedPaths:[...protectedPaths]});
      if(destination instanceof Error) throw destination;
      return destination;
    }
  });
  const doc = api.buildDoc('{"example":1}','example.json',13);
  doc.path = 'D:/example.json';
  api.add(doc);
  api.configure({nodeSelectionStyle:true});
  api.setTemplate({paths:['$.example']});
  const button = elements.get('exportSettingsBtn');
  const exportSettings = button.listeners.get('click');
  const toast = elements.get('toast');
  const pending = exportSettings();
  assert.equal(button.disabled,true);
  await exportSettings();
  await pending;
  assert.equal(button.disabled,false);
  assert.equal(calls.length,1);
  const [{name,payload,originalPath,protectedPaths}] = calls;
  assert.equal(name,'json-atlas-settings.json');
  assert.equal(originalPath,null);
  assert.deepEqual(protectedPaths,['D:/example.json']);
  assert.equal(payload.app,'json-atlas');
  assert.equal(payload.appName,'JSON Atlas');
  assert.equal(payload.appVersion,manifest.version);
  assert.equal(payload.version,1);
  assert.equal(payload.settings.nodeSelectionStyle,true);
  assert.deepEqual(payload.template,{paths:['$.example']});
  assert.equal(toast.classList.contains('show'),false);
  destination = 'D:/backups/settings.json';
  await exportSettings();
  assert.equal(toast.textContent,'设置已导出');
  destination = new Error('磁盘写入失败');
  await exportSettings();
  assert.match(toast.textContent,/导出设置失败.*磁盘写入失败/);
  assert.equal(button.disabled,false);
});

test('design drafts recover without session restore and are cleared on save or discard', async () => {
  const storage = new Map();
  const saved = [];
  const native = {desktop:true, updateDocumentMenu(){}, guardEditedClose:async()=>{},
    saveDocumentCopy:async (name, text) => { saved.push([name, JSON.parse(text)]); return 'C:/untitled.json'; }};
  const first = reader(storage, native);
  first.elements.get('newDocBtn').click();
  await first.flush();
  first.elements.get('tree').firstElementChild._card.children.find(child => child.className === 'topic-add').click();
  await first.flush();
  assert.equal([...storage.keys()].some(key => key.includes('lastfile')),false);

  const reopened = reader(storage, native);
  await reopened.flush();
  assert.equal(reopened.api.state().doc.dirty,true);
  assert.equal(reopened.api.state().doc.temporary,true);
  assert.deepEqual(JSON.parse(reopened.api.state().doc.text),{'子主题':{}});
  await reopened.api.saveCurrentDocument();
  assert.deepEqual(saved[0][1],{'子主题':{}});
  assert.equal(reader(storage, native).api.allDocs().length,0);

  reopened.elements.get('newAnotherBtn').click();
  await reopened.flush();
  const id = reopened.api.state().doc.id;
  reopened.api.closeDoc(id);
  reopened.elements.get('discardEditCancel').click();
  await Promise.resolve();
  assert.equal(reader(storage, native).api.allDocs().length,1);
  reopened.api.closeDoc(id);
  reopened.elements.get('discardEditConfirm').click();
  await Promise.resolve();
  assert.equal(reader(storage, native).api.allDocs().length,0);
});

test('blank documents offer topic actions in the tree and save as ordinary JSON', async () => {
  const saves = [];
  const {api,elements,keyListeners,flush} = reader(new Map(), {
    desktop:true, updateDocumentMenu(){}, guardEditedClose:async()=>{},
    saveDocumentCopy:async(name,text) => { saves.push([name,JSON.parse(text),Buffer.byteLength(text)]); return 'C:\\plan.json'; }
  });
  api.configure({viewMode:'ide'});
  elements.get('newDocBtn').click();
  await flush();
  assert.equal(elements.get('ideView').hidden,true);
  assert.equal(elements.get('designDock').hidden,true);
  assert.equal(elements.get('designRename').disabled,true);
  assert.equal(api.state().doc.dirty,true);
  const settingsToggle = elements.get('optTopicDock');
  const setDock = checked => settingsToggle.listeners.get('change')({target:{checked}});
  setDock(true);
  assert.equal(elements.get('designDock').hidden,false);
  setDock(false);
  assert.equal(elements.get('designDock').hidden,true);

  const tree = elements.get('tree');
  const rootCard = () => tree.firstElementChild._card;
  const badge = card => card.querySelectorAll('.badge')[0].textContent;
  assert.equal(tree.firstElementChild._keyEl.textContent,'root');
  assert.equal(badge(rootCard()),'Object · 0');
  const plus = card => card.children.find(child => child.className === 'topic-add');
  plus(rootCard()).click();
  await flush();
  assert.equal(Object.hasOwn(api.state().doc.parsed,'子主题'),true);
  assert.equal(badge(rootCard()),'Object · 1');
  assert.equal(badge(tree.querySelectorAll('.node-card').find(card => card !== rootCard())),'未指定类型');
  const editedBytes = Buffer.byteLength(api.state().doc.text);
  assert.ok(editedBytes > api.state().doc.text.length);
  assert.ok(elements.get('fileSub').textContent.startsWith(`${editedBytes} B ·`));
  assert.equal(plus(rootCard()),undefined);
  api.selectCopyNode(tree.firstElementChild);
  plus(rootCard()).click();
  await flush();
  assert.equal(Object.hasOwn(api.state().doc.parsed,'子主题 2'),true);
  elements.get('undoEditBtn').click();
  await flush();
  elements.get('undoEditBtn').click();
  await flush();

  assert.ok(elements.get('fileSub').textContent.startsWith('3 B ·'));

  const submit = name => {
    elements.get('designTopicName').value = name;
    elements.get('designTopicForm').listeners.get('submit')({preventDefault(){}});
  };
  const keydown = key => keyListeners.get('keydown')({key,target:elements.get('viewport'),preventDefault(){}});
  const openRootMenu = () => tree.listeners.get('contextmenu')({
    target:{closest:() => ({closest:() => tree.firstElementChild})},
    preventDefault(){}, stopPropagation(){}, clientX:100, clientY:100
  });
  openRootMenu();
  assert.equal(elements.get('topicMenu').hidden,false);
  assert.equal(elements.get('ctxTopicSibling').disabled,true);
  elements.get('ctxTopicChild').click(); submit('计划');
  await flush();
  assert.equal(elements.get('designRename').disabled,false);
  keydown('Tab'); submit('调研');
  await flush();
  keydown('Enter'); submit('调研');
  assert.match(elements.get('designTopicError').textContent,/同级主题/);
  submit('开发');
  await flush();
  keydown('F2'); submit('__proto__');
  await flush();
  keydown('Delete');
  await flush();
  elements.get('designUndo').click();
  await flush();
  await api.saveCurrentDocument();
  assert.equal(saves[0][0],'未命名-1.json');
  assert.deepEqual(saves[0][1],{计划:{调研:{},['__proto__']:{}}});
  assert.equal(api.state().doc.path,'C:\\plan.json');
  assert.equal(api.state().doc.dirty,false);
  assert.ok(elements.get('fileSub').textContent.startsWith(`${saves[0][2]} B ·`));
  const opened = api.buildDoc('{}','opened.json',2);
  api.add(opened); api.activateDoc(opened.id);
  openRootMenu();
  assert.equal(elements.get('topicMenu').hidden,true);
  assert.equal(plus(rootCard()),undefined);
});

test('IDE folding retains source for save, formatting and search and guards hidden deletions', async () => {
  const writes = [];
  const {api,elements} = reader(new Map(),{desktop:true, updateDocumentMenu(){}, guardEditedClose:async()=>{}, saveNativeDocument:async(...args)=>writes.push(args)}); api.configure({viewMode:'ide'});
  const raw = '{\n  "a": {\n    "secret": 1\n  },\n  "b": 2\n}';
  const doc = api.buildDoc(raw,'fold.json',raw.length); doc.path='C:\\fold.json'; api.add(doc); api.activateDoc(doc.id);
  const input = elements.get('ideInput');
  api.toggleIdeFold(1); assert.equal(input.value.includes('secret'),false);
  assert.equal(doc.text,raw); assert.equal(doc.dirty,undefined);
  api.handleIdeInput(''); assert.equal(doc.text,raw); assert.equal(input.value,raw);
  api.toggleIdeFold(1); api.handleIdeInput(input.value.replace('"b": 2','"b": 3'));
  assert.equal(doc.parsed.a.secret,1); assert.equal(doc.parsed.b,3);
  api.toggleIdeFold(1); await api.saveCurrentDocument(); assert.match(writes[0][1],/secret/); assert.equal(doc.ideFolds.size,1);
  api.toggleIdeFold(1); api.formatIde(); assert.equal(doc.parsed.a.secret,1); assert.match(input.value,/secret/);
  api.toggleIdeFold(1); await api.searchTree('secret');
  assert.equal(doc.ideFolds.size,0); assert.match(input.value,/secret/);
});

test('theme preference persists and is shown when settings reopen', () => {
  const {elements,storage,keyListeners} = reader();
  const selector = elements.get('optTheme'); selector.value = 'dark';
  selector.listeners.get('change')({target:selector});
  const reopened = reader(storage);
  reopened.keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  assert.equal(reopened.elements.get('optTheme').value,'dark');
  keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  assert.equal(selector.value,'dark');
});

test('settings category navigation switches panels and supports arrow keys without changing options', () => {
  const {elements,keyListeners}=reader();
  keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  assert.equal(elements.get('settingsPage0').hidden,false);
  elements.get('settingsNav2').click();
  elements.get('settingsNav2').listeners.get('keydown')({key:'ArrowDown',preventDefault(){}});
  assert.equal(elements.get('settingsPage6').hidden,false);
  assert.equal(elements.get('settingsFooter').hidden,true);
  elements.get('settingsNav6').listeners.get('keydown')({key:'ArrowDown',preventDefault(){}});
  assert.equal(elements.get('settingsPage0').hidden,true);
  assert.equal(elements.get('settingsPage3').hidden,false);
  assert.equal(elements.get('recordTemplateBtn2').hidden,false);
  let prevented=false;
  elements.get('settingsNav3').listeners.get('keydown')({key:'ArrowDown',preventDefault(){prevented=true;}});
  assert(prevented);assert.equal(elements.get('settingsPage4').hidden,false);
  assert.equal(elements.get('recordTemplateBtn2').hidden,true);
});

test('custom shortcuts switch views, toggle tree editing and reset IDE zoom without changing content', () => {
  const {api,elements,keyListeners}=reader();
  const doc=api.buildDoc('{"a":1}','keys.json',7); api.add(doc); api.activateDoc(doc.id);
  const press=key=>keyListeners.get('keydown')({key,ctrlKey:true,altKey:true,target:elements.get('viewport'),preventDefault(){}});
  press('e'); assert.equal(elements.get('editModeBtn').textContent,'退出编辑');
  press('e'); assert.equal(elements.get('editModeBtn').textContent,'编辑模式');
  press('v'); assert.equal(elements.get('ideView').hidden,false);
  doc.ideZoom=150; press('0'); assert.equal(doc.ideZoom,100);
  assert.match(elements.get('switchViewBtn').title,/Ctrl\+Alt\+V/);
  elements.get('settingsBtn').click(); press('v'); assert.equal(elements.get('ideView').hidden,false);
  elements.get('settingsClose').click(); press('v'); assert.equal(elements.get('ideView').hidden,true);
  assert.equal(doc.text,'{"a":1}');
});

test('native menu updates retain shortcuts when view labels and enabled states change', () => {
  let menu;
  const {api,elements}=reader(new Map(),{desktop:true,guardEditedClose:async()=>{},updateDocumentMenu:items=>{menu=items;}});
  assert.equal(menu.find(item=>item.id==='close').enabled,false);
  const doc=api.buildDoc('{}','keys.json',2); api.add(doc); api.activateDoc(doc.id);
  assert.equal(menu.find(item=>item.id==='close').shortcut,'Ctrl+F4');
  assert.equal(menu.find(item=>item.id==='format-json').shortcut,'Ctrl+Alt+L');
  assert.equal(menu.find(item=>item.id==='settings').shortcut,'Ctrl+Alt+S');
  assert.equal(menu.find(item=>item.id==='switch-view').text,'IDE 视图');
  elements.get('switchViewBtn').click();
  assert.equal(menu.find(item=>item.id==='switch-view').text,'树形视图');
  assert.equal(menu.find(item=>item.id==='switch-view').shortcut,'Ctrl+Alt+V');
  assert.equal(menu.find(item=>item.id==='edit-mode').enabled,false);
  elements.get('switchViewBtn').click();
  api.openEditor();
  const item = id => menu.find(entry => entry.id === id);
  for(const id of ['open','close','save-copy','switch-view','edit-mode','undo-edit','format-json','settings','about','check-update']){
    assert.equal(item(id).enabled, false, id);
  }
  assert.equal(item('save').text,'应用模板');
  assert.equal(item('save').enabled,true);
  assert.equal(item('find').enabled,true);
  assert.equal(item('reset').enabled,true);
  elements.get('editorClose').click();
  assert.equal(item('open').enabled,true);
  assert.equal(item('settings').enabled,true);
  assert.equal(item('save').enabled,false);
});

test('find shortcut opens a modeless window; dragging, pinning and remembered placement cooperate', () => {
  const { api, elements, storage, keyListeners, window, setToolbarBottom } = reader();
  const doc = api.buildDoc('{"a":1}', 'find.json', 7); api.add(doc); api.activateDoc(doc.id);
  const panel = elements.get('findPanel'), handle = elements.get('findDragHandle');
  assert.equal(panel.hidden, true);
  keyListeners.get('keydown')({ key:'f', ctrlKey:true, preventDefault(){} });
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.left, '814px');
  handle.listeners.get('pointerdown')({button:0,pointerId:1,clientX:820,clientY:70,target:{closest:()=>null},preventDefault(){}});
  handle.listeners.get('pointermove')({pointerId:1,clientX:520,clientY:170});
  handle.listeners.get('pointerup')();
  assert.equal(panel.style.left, '514px'); assert.equal(panel.style.top, '166px');
  elements.get('pinFindBtn').listeners.get('click')();
  handle.listeners.get('pointerdown')({button:0,pointerId:2,clientX:520,clientY:170,target:{closest:()=>null},preventDefault(){}});
  handle.listeners.get('pointermove')({pointerId:2,clientX:0,clientY:0});
  assert.equal(panel.style.left, '514px');
  window.innerWidth = 1920;
  api.positionFindPanel();
  assert.equal(panel.style.left, '994px'); assert.equal(panel.style.top, '166px');
  window.innerWidth = 640;
  setToolbarBottom(92);
  api.positionFindPanel();
  assert.equal(panel.style.left, '12px'); assert.equal(panel.style.top, '204px');
  window.innerWidth = 1920;
  setToolbarBottom(54);
  api.positionFindPanel();
  assert.equal(panel.style.left, '994px'); assert.equal(panel.style.top, '166px');
  window.innerWidth = 640;
  api.positionFindPanel();
  elements.get('closeFindBtn').listeners.get('click')(); assert.equal(panel.hidden, true);
  const reopened = reader(storage), next = reopened.api.buildDoc('{}', 'other.json', 2);
  reopened.api.add(next); reopened.api.activateDoc(next.id);
  assert.equal(reopened.elements.get('findPanel').hidden, true);
  reopened.elements.get('findBtn').listeners.get('click')();
  assert.equal(reopened.elements.get('findPanel').style.left, '514px');
  assert.equal(reopened.elements.get('findPanel').dataset.pinned, 'true');
});

test('find window stays below the toolbar for dragging, keyboard moves and pinned saved positions', () => {
  const storage=new Map([['json-atlas_find-window_v1',JSON.stringify({x:300,y:12,pinned:true})]]);
  const {api,elements,window,setToolbarBottom}=reader(storage);
  const doc=api.buildDoc('{}','find.json',2); api.add(doc); api.activateDoc(doc.id);
  elements.get('findBtn').click();
  const panel=elements.get('findPanel'),handle=elements.get('findDragHandle');
  assert.equal(panel.style.top,'66px');
  assert.equal(panel.style.left,'814px');
  assert.deepEqual(JSON.parse(storage.get('json-atlas_find-window_v2')), {edge:'right',inset:16,top:0,pinned:true});
  window.innerWidth = 1920;
  api.positionFindPanel(); assert.equal(panel.style.left,'1294px');
  window.innerWidth = 1440;
  api.positionFindPanel(); assert.equal(panel.style.left,'814px');
  assert.equal(panel.dataset.pinned,'true');
  elements.get('pinFindBtn').click();
  handle.listeners.get('pointerdown')({button:0,pointerId:1,clientX:320,clientY:76,target:{closest:()=>null},preventDefault(){}});
  handle.listeners.get('pointermove')({pointerId:1,clientX:320,clientY:-200});
  handle.listeners.get('pointerup')(); assert.equal(panel.style.top,'66px');
  handle.listeners.get('keydown')({key:'ArrowUp',target:handle,preventDefault(){}}); assert.equal(panel.style.top,'66px');
  setToolbarBottom(140); api.positionFindPanel(); assert.equal(panel.style.top,'152px');
  assert.equal(panel.style.maxHeight,'736px');
  api.positionFindPanel(99999,99999); assert.equal(panel.style.left,'818px'); assert.equal(panel.style.top,'786px');
  api.positionFindPanel(120, 152);
  window.innerWidth = 1920;
  api.positionFindPanel(); assert.equal(panel.style.left,'120px');
});

test('cancelling a queued native batch skips its remaining files but permits a later batch', async () => {
  const calls = []; let release;
  const first = 'D:\\test files\\前两个.json';
  const nextFile = '/test files/third.json';
  const {api, elements} = reader(new Map(), {statNativeFile: path => {
    calls.push(path);
    return new Promise(resolve => { release = resolve; });
  }});
  const pending = api.openPaths([first, 'second.json']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('loadingLabel').textContent, '正在读取 前两个.json…');
  elements.get('cancelLoadBtn').click();
  release({path:first, name:'前两个.json', size:2});
  await pending;
  assert.deepEqual(calls, [first]);
  const next = api.openPaths([nextFile]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('loadingLabel').textContent, '正在读取 third.json…');
  elements.get('cancelLoadBtn').click();
  release({path:nextFile, name:'third.json', size:2});
  await next;
  assert.deepEqual(calls, [first, nextFile]);
});

test('idle memory release retains reading state and skips files with edits', async () => {
  const {api,flush} = reader();
  api.configure({idleReleaseMinutes:1});
  const first = api.buildDoc('{"nested":{"value":42}}','first.json',23);
  const current = api.buildDoc('{}','current.json',2);
  const edited = api.buildDoc('{}','edited.json',2);
  const undoable = api.buildDoc('{}','undoable.json',2);
  edited.dirty = true;
  undoable.editHistory = [{}];
  for(const doc of [first,current,edited,undoable]) api.add(doc);
  api.activateDoc(first.id);
  await flush();
  await api.expandByPaths(['$', '$.nested'], {exact:true});
  const source = first.source;
  api.activateDoc(current.id);
  for(const doc of [first,current,edited,undoable]) doc.inactiveSince = 0;
  api.releaseIdleDocuments();
  assert.equal(first.unloaded,'idle');
  assert.equal(first.parsed,undefined);
  assert.throws(() => source.getRoot(), /文档已关闭/);
  assert.deepEqual(Array.from(first.openPaths), ['$', '$.nested']);
  assert.equal(current.unloaded,undefined);
  assert.equal(edited.unloaded,undefined);
  assert.equal(undoable.unloaded,undefined);
  api.activateDoc(first.id);
  await flush();
  assert.equal(first.parsed.nested.value,42);
  assert.deepEqual(Array.from(first.openPaths), ['$', '$.nested']);
});

test('manual background release updates the visible counts and preserves protected tabs', () => {
  const {api,elements,keyListeners} = reader();
  const current = api.buildDoc('{}','current.json',2);
  const background = api.buildDoc('{"clean":1}','background.json',11);
  const dirty = api.buildDoc('{}','dirty.json',2);
  dirty.dirty = true;
  const deferred = api.buildDoc('{}','deferred.json',2);
  deferred.unloaded = 'restore';
  for(const doc of [current,background,dirty,deferred]) api.add(doc);
  api.activateDoc(current.id);
  const owner = 'performance-test';
  sharedPageCache.put(owner,'root',{start:0,items:[]});
  try{
    keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
    elements.get('settingsNav6').click();
    const status = elements.get('residentFileStatus');
    assert.equal(status.textContent,'已载入 3 个 · 待载入 1 个 · 已释放 0 个');
    assert.match(elements.get('indexCacheStatus').textContent,/已缓存 1 页（约 .*） · 预算 32\.00 MB/);
    elements.get('releaseBackgroundFiles').click();
    assert.equal(status.textContent,'已载入 2 个 · 待载入 1 个 · 已释放 1 个');
    assert.equal(background.unloaded,'idle');
    assert.equal(dirty.unloaded,undefined);
    const released = () => elements.get('fileRail').querySelectorAll('.file-slot.released').map(slot => slot.dataset.id);
    assert.deepEqual(released(),[background.id]);
    assert.equal(elements.get('releaseBackgroundFiles').disabled,true);
    assert.equal(api.state().doc,current);
    api.activateDoc(background.id);
    assert.deepEqual(released(),[]);
  }finally{
    sharedPageCache.deleteOwner(owner);
  }
});

test('index cache status distinguishes open indexed files from cached pages', async () => {
  const {api,elements,keyListeners} = reader();
  const doc = api.buildDoc('[]','indexed.json',2);
  const source = new IndexedDataSource(async op => op === 'page'
    ? {start:0,end:1,total:1,items:[{key:0,path:[0],type:'number',value:42,arrayItem:true}]}
    : true, 'cache-status', {kind:'json',root:{type:'array',path:[],childCount:1}});
  doc.source = source;
  api.add(doc);
  api.activateDoc(doc.id);
  keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  elements.get('settingsNav6').click();
  const status = elements.get('indexCacheStatus');
  try{
    assert.match(status.textContent,/索引文件 1 个 · 暂无缓存页/);
    await source.getChildren([]);
    elements.get('settingsNav6').click();
    assert.match(status.textContent,/索引文件 1 个 · 已缓存 1 页（约 [1-9]/);
  }finally{
    source.dispose();
  }
});

test('resident limit releases least recently read tabs and allows protected files over the limit', () => {
  const {api,elements,keyListeners,storage} = reader();
  const [old,recent,dirty,current] = ['old','recent','dirty','current']
    .map(name=>api.buildDoc('{}',name+'.json',2));
  dirty.dirty = true;
  for(const doc of [old,recent,current]) api.add(doc);
  old.inactiveSince = 1;
  recent.inactiveSince = 2;
  api.activateDoc(current.id);
  keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  elements.get('settingsNav6').click();
  const limit = elements.get('optResidentFileLimit');
  limit.value = '2';
  limit.listeners.get('change')();
  assert.equal(old.unloaded,undefined);
  elements.get('settingsClose').click();
  assert.equal(JSON.parse(storage.get('json-atlas_settings_v1')).residentFileLimit,2);
  assert.equal(old.unloaded,'idle');
  assert.equal(recent.unloaded,undefined);

  api.add(dirty);
  api.configure({residentFileLimit:1});
  current.editHistory = [{}];
  api.activateDoc(recent.id);
  assert.equal(recent.unloaded,undefined);
  assert.equal(current.unloaded,undefined);
  assert.equal(dirty.unloaded,undefined);
  assert.equal(old.unloaded,'idle');
  assert.equal(api.state().doc,recent);
});

test('low memory startup only opens the selected native file and restores other tabs on demand', async () => {
  const paths = ['D:/first.json', 'D:/active.json', 'D:/last.json'];
  const opened = [];
  const storage = new Map([
    ['json-atlas_settings_v1', JSON.stringify({reopenLast:true,lowMemoryMode:true})],
    ['json-atlas_lastfile_v1', JSON.stringify({docs:paths.map(path => ({path})), activeKey:paths[1]})],
    ['json-atlas_session_v1', JSON.stringify({docs:{['d:/last.json']:{paths:['$'],view:{x:16,y:20,scale:.8}}}})]
  ]);
  const {api,flush} = reader(storage, {
    desktop:true, updateDocumentMenu(){}, guardEditedClose:async()=>{},
    statNativeFile:async path => { opened.push(path); return {path,name:path.split('/').at(-1),size:70 * 1024 ** 2}; },
    openIndexedFile:async ({path}) => new IndexedDataSource(async () => true, path, {
      kind:'json', root:{type:'number',value:42,path:[],childCount:0}
    })
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened,[paths[1]]);
  assert.equal(api.state().doc.path,paths[1]);
  assert.deepEqual(Array.from(api.allDocs(),doc=>doc.path),paths);
  assert.equal(api.allDocs()[2].unloaded,'restore');
  await api.activateDoc(api.allDocs()[2].id);
  await flush();
  assert.deepEqual(opened,[paths[1],paths[2]]);
  assert.equal(api.state().doc.path,paths[2]);
  assert.deepEqual(Array.from(api.state().doc.openPaths),['$']);
  assert.equal(api.state().view.scale,.8);
  assert.equal(api.allDocs()[0].unloaded,'restore');
  const previous = api.allDocs()[1];
  const source = previous.source;
  api.configure({idleReleaseMinutes:1});
  previous.inactiveSince = 0;
  api.releaseIdleDocuments();
  assert.equal(previous.unloaded,'idle');
  assert.throws(() => source.getRoot());
  assert.equal(previous.text,undefined);
  await api.activateDoc(previous.id);
  assert.equal(api.state().doc,previous);
  assert.deepEqual(opened,[paths[1],paths[2],paths[1]]);
});

test('new and selected files preempt restoration without losing pending files or stealing focus on completion', async () => {
  const paths = ['D:/first.json', 'D:/previous.json', 'D:/last.json'];
  const opened = [];
  const pending = new Map();
  let idle;
  const storage = new Map([
    ['json-atlas_settings_v1', JSON.stringify({reopenLast:true})],
    ['json-atlas_lastfile_v1', JSON.stringify({docs:paths.map(path => ({path})), activeKey:paths[1]})]
  ]);
  const {api, elements, flush} = reader(storage, {
    desktop:true, updateDocumentMenu(){}, guardEditedClose:async()=>{},
    window:{
      innerWidth:1440, innerHeight:900, addEventListener(){},
      requestIdleCallback(callback){ idle = callback; return 1; },
      cancelIdleCallback(){ idle = null; }
    },
    statNativeFile:async path => ({path, name:path.split('/').at(-1), size:70 * 1024 ** 2}),
    openIndexedFile:({path}, {signal}) => new Promise((resolve, reject) => {
      opened.push(path);
      signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      pending.set(path, () => resolve(new IndexedDataSource(async () => true, path, {
        kind:'json', root:{type:'number', value:42, path:[], childCount:0}
      })));
    })
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const runIdle = async () => {
    assert.ok(idle);
    const callback = idle;
    idle = null;
    callback();
    await tick();
  };
  const rail = elements.get('fileRail');
  const loading = () => rail.querySelectorAll('.file-slot.loading');
  await tick();
  assert.deepEqual(opened, [paths[1]]);
  assert.equal(loading().length, 3);
  assert.equal(elements.get('viewer').classList.contains('pending-files'), true);
  const latest = 'D:/new.json';
  const next = api.openPaths([latest]);
  await tick();
  assert.deepEqual(opened, [paths[1], latest]);
  assert.equal(loading().length, 4);
  assert.equal(JSON.parse(storage.get('json-atlas_lastfile_v1')).docs.length, 4);
  pending.get(latest)();
  await next;
  await tick();
  await flush();
  assert.equal(api.state().doc.path, latest);
  assert.equal(loading().length, 3);
  assert.equal(elements.get('loadingStatus').hidden, true);
  assert.deepEqual(opened, [paths[1], latest]);
  await runIdle();
  assert.equal(opened.at(-1), paths[0]);

  const select = loading().find(slot => slot.querySelectorAll('.file-tab-name')[0].textContent === 'last.json');
  select.click();
  await tick();
  assert.equal(opened.at(-1), paths[2]);
  pending.get(paths[2])();
  await tick();
  assert.equal(api.state().doc.path, paths[2]);
  for(const path of paths.slice(0,2)){
    await runIdle();
    assert.equal(opened.at(-1), path);
    pending.get(path)();
    await tick();
  }
  assert.equal(loading().length, 0);
  assert.equal(api.state().doc.path, paths[2]);
  assert.deepEqual(Array.from(api.allDocs(), doc => doc.path), [...paths, latest]);
});

test('stored settings cannot set the prototype or overwrite settings with the wrong type', () => {
  const storage = new Map([['json-atlas_settings_v1', '{"__proto__":{"polluted":true},"strictJsonl":"false","largeFileThresholdMiB":128}']]);
  const {elements} = reader(storage);
  elements.get('settingsBtn').click();
  assert.equal(elements.get('optStrictJsonl').checked, false);
  assert.equal(elements.get('optLargeFileThreshold').value, '128');
});

test('new toolbar queries restore plain matching and synchronize both search fields and counts', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('{"a":"Cat","b":"cat","c":"catalog"}', 'search.json', 35);
  api.add(doc); api.activateDoc(doc.id);
  const input = elements.get('searchInput'), quick = elements.get('quickSearchInput');
  input.value = 'cat'; await api.searchTree('cat');
  assert.equal(quick.value, 'cat'); assert.equal(elements.get('quickSearchCount').textContent, '1 / 3');
  elements.get('searchCaseBtn').listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('quickSearchCount').textContent, '1 / 2');
  quick.value = 'CAT'; quick.listeners.get('input')({});
  assert.equal(elements.get('quickSearchCount').textContent, '搜索中…');
  assert.equal(elements.get('quickNextMatchBtn').disabled, true);
  await quick.listeners.get('keydown')({key:'Enter',preventDefault(){},stopPropagation(){}});
  assert.equal(input.value, 'CAT'); assert.equal(elements.get('quickSearchCount').textContent, '1 / 3');
  elements.get('clearSearchBtn').listeners.get('click')();
  assert.equal(quick.value, ''); assert.equal(elements.get('quickNextMatchBtn').disabled, true);
});

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

test('wide files do not prompt automatically; blocked expansion cleanup releases content and clears the notice', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc(JSON.stringify(Array.from({length:2}, () => Array.from({length:3000}, (_, i) => i))), 'wide.json', 1);
  api.add(doc); api.activateDoc(doc.id);
  const root = elements.get('tree').firstElementChild;
  await api.expandOne(root);
  assert.equal(elements.get('nodeBudgetNotice').hidden, true);
  for(const branch of elements.get('tree').querySelectorAll('.tree-node').filter(node => node._path.length === 1)) await api.expandOne(branch);
  api.showNodeLimit();
  assert.equal(elements.get('nodeBudgetNotice').hidden, false);
  const cleanup = elements.get('reclaimNodesBtn').listeners.get('click');
  cleanup();
  const remaining = elements.get('tree').querySelectorAll('.tree-node').length;
  assert(remaining <= 4000 && remaining > 1);
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

test('find options rerun matching, both navigation buttons work, and clear removes results', async () => {
  const { api, elements } = reader();
  const doc = api.buildDoc('{"a":"Cat","b":"cat","c":"catalog"}', 'find.json', 30); api.add(doc); api.activateDoc(doc.id);
  await api.searchTree('cat'); assert.equal(elements.get('searchCount').textContent, '1 / 3');
  elements.get('nextMatchBtn').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('searchCount').textContent, '2 / 3');
  elements.get('prevMatchBtn').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('searchCount').textContent, '1 / 3');
  elements.get('searchInput').value = 'cat';
  elements.get('searchCaseBtn').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('searchCount').textContent, '1 / 2');
  elements.get('searchWordBtn').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('searchCount').textContent, '1 / 1');
  elements.get('searchRegexBtn').listeners.get('click')(); await new Promise(resolve => setImmediate(resolve));
  elements.get('searchInput').value = '['; await api.searchTree('[');
  assert.equal(elements.get('searchError').hidden, false); assert.equal(elements.get('prevMatchBtn').disabled, true);
  elements.get('clearSearchBtn').listeners.get('click')();
  assert.equal(elements.get('searchInput').value, ''); assert.equal(elements.get('searchError').hidden, true);
  assert.equal(elements.get('nextMatchBtn').disabled, true);
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

test('session restoration keeps per-file IDE and design modes and restores the IDE reading position', async () => {
  const storage = new Map([['json-atlas_settings_v1', JSON.stringify({reopenLast:true})]]);
  const {api,elements,keyListeners,flush} = reader(storage);
  const text = '{\n  "inner": {\n    "name": "value"\n  },\n  "sibling": true\n}';
  const first = api.buildDoc(text, 'ide.json', text.length);
  const second = api.buildDoc('{}', 'design.json', 2);
  api.add(first); api.add(second); api.activateDoc(first.id);
  await flush();
  elements.get('switchViewBtn').click();
  const input = elements.get('ideInput');
  api.toggleIdeFold(1);
  input.listeners.get('wheel')({ctrlKey:true,deltaY:-1,preventDefault(){}});
  input.setSelectionRange(2,5,'backward');
  input.scrollTop = 45;
  input.scrollLeft = 16;
  api.activateDoc(second.id);
  const viewport = elements.get('viewport');
  let handled = false;
  keyListeners.get('keydown')({key:'d',code:'KeyD',target:viewport,ctrlKey:true,altKey:true,preventDefault(){handled=true;}});
  assert.equal(handled,true);
  assert.equal(second.design,true);
  await flush();
  const restarted = reader(storage);
  assert.equal(restarted.api.state().doc.design,true);
  restarted.api.activateDoc(restarted.api.allDocs().find(doc=>doc.name==='ide.json').id);
  assert.equal(restarted.elements.get('ideView').hidden,false);
  const restored = restarted.elements.get('ideInput');
  assert.equal(restored.selectionStart,2);
  assert.equal(restored.selectionEnd,5);
  assert.equal(restored.selectionDirection,'backward');
  assert.equal(restored.scrollTop,45);
  assert.equal(restored.scrollLeft,16);
  assert.equal(restarted.api.state().doc.ideZoom,110);
  assert.equal(restarted.api.state().doc.ideFolds.has(1),true);
});

test('tree sessions restore the visible page even when no child branch is expanded', async () => {
  const storage = new Map([['json-atlas_settings_v1', JSON.stringify({reopenLast:true})]]);
  const {api,elements,flush} = reader(storage);
  const text=JSON.stringify(Array.from({length:3010},(_,i)=>i));
  const doc=api.buildDoc(text,'paged.json',text.length);
  api.add(doc); api.activateDoc(doc.id);
  await flush();
  await api.expandOne(elements.get('tree').firstElementChild,undefined,3000);
  api.saveSession();
  const restarted=reader(storage);
  await restarted.flush();
  const tree=restarted.elements.get('tree');
  assert.equal(tree.firstElementChild._pageStart,3000);
  assert.equal(tree.querySelectorAll('.tree-node')[1].dataset.path,'$[3000]');
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
  assert.equal(elements.get('viewer').classList.contains('template-editing'), true);
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

test('hiding and restoring a node uses the template without collapsing open branches', async () => {
  const { api, elements, flush } = reader();
  const raw = '{"secret":1,"other":2,"keep":{"nested":{"value":3}}}';
  const doc = api.buildDoc(raw, 'data.json', raw.length);
  api.add(doc);
  api.activateDoc(doc.id);
  await flush();
  const paths = ['$', '$.keep', '$.keep.nested'];
  await api.expandByPaths(paths, { exact: true });
  const tree = elements.get('tree');
  const openPaths = () => tree.querySelectorAll('.tree-node.open').map(node => node.dataset.path);
  const hide = path => {
    const node = tree.querySelectorAll('.tree-node').find(child => child.dataset.path === path);
    assert.ok(node);
    elements.get('tree').listeners.get('contextmenu')({
      target: { closest: () => ({ closest: () => node }) },
      clientX: 300, clientY: 100, preventDefault() {}, stopPropagation() {}
    });
    elements.get('ctxHideNode').click();
  };
  Object.assign(elements.get('ctxMenu'), { offsetWidth: 170, offsetHeight: 220 });
  hide('$.secret');
  await flush();
  hide('$.other');
  await flush();
  assert.deepEqual(Array.from(api.template().hidden), ['$.secret', '$.other']);
  assert.equal(nodeKeys(tree).includes('secret'), false);
  assert.deepEqual(openPaths(), paths);

  api.openEditor();
  elements.get('editorSaveBtn').click();
  await flush();
  assert.deepEqual(openPaths(), paths);

  const list = elements.get('hiddenTemplateList');
  const group = list.firstElementChild;
  assert.equal(list.children.length,1);
  assert.equal(group.firstElementChild.open,false);
  const summary = group.firstElementChild.firstElementChild;
  assert.deepEqual(summary.children.map(item => item.textContent),['data.json','2']);
  const rules = group.firstElementChild.children[1];
  const mask = rules.firstElementChild.children[2];
  assert.equal(mask.title,'仅对当前活动文件有效');
  mask.click();
  await flush();
  assert.equal(mask.textContent,'取消屏蔽');
  assert.equal(mask.dataset.masked,'true');
  assert.ok(nodeKeys(tree).includes('secret'));
  assert.deepEqual(Array.from(api.template().hidden), ['$.secret', '$.other']);

  const second = api.buildDoc('{"secret":2,"newRule":3}', 'second.json', 24);
  api.add(second);
  api.activateDoc(second.id);
  await flush();
  await api.expandByPaths(['$'], {exact:true});
  assert.equal(nodeKeys(tree).includes('secret'),false);
  hide('$.newRule');
  await flush();
  assert.equal(list.children.length,2);
  assert.equal(api.template().hiddenSources['$.secret'].name,'data.json');
  assert.equal(api.template().hiddenSources['$.newRule'].name,'second.json');

  api.activateDoc(doc.id);
  await flush();
  assert.ok(nodeKeys(tree).includes('secret'));
  list.firstElementChild.firstElementChild.children[1].firstElementChild.children[1].click();
  assert.deepEqual(Array.from(api.template().hidden), ['$.other', '$.newRule']);
  list.firstElementChild.children[1].click();
  assert.deepEqual(Array.from(api.template().hidden), ['$.newRule']);
  list.firstElementChild.children[1].click();
  await flush();
  assert.equal(api.template().hidden.length, 0);
  assert.ok(nodeKeys(tree).includes('secret'));
  assert.ok(nodeKeys(tree).includes('other'));
  assert.deepEqual(openPaths(), paths);
  assert.equal(doc.text, raw);
});

test('legacy rule sources merge by filename and settings search filters paths', () => {
  const key = 'json-atlas_template_v1';
  const storage = new Map([[key, JSON.stringify({
    paths: [], hidden: ['$.first', '$.second', '$.other'],
    hiddenSources: {
      '$.first': {key:'C:/original/data.json',name:'data.json'},
      '$.second': {key:'D:/copies/data.json',name:'data.json'},
      '$.other': {key:'/old/other.json',name:'other.json'}
    }
  })]]);
  const {elements,keyListeners} = reader(storage);
  assert.deepEqual(JSON.parse(storage.get(key)).hiddenSources, {
    '$.first': {name:'data.json'}, '$.second': {name:'data.json'}, '$.other': {name:'other.json'}
  });
  keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  const search = elements.get('hiddenTemplateSearch'), list = elements.get('hiddenTemplateList');
  assert.equal(list.children.length,2);
  search.value = 'DATA.JSON'; search.listeners.get('input')();
  assert.equal(list.children.length,1);
  assert.equal(list.firstElementChild.firstElementChild.children[1].children.length,2);
  search.value = '$.second'; search.listeners.get('input')();
  const details = list.firstElementChild.firstElementChild;
  assert.equal(details.open,true);
  assert.equal(details.children[1].children.length,1);
  assert.equal(details.children[1].firstElementChild.firstElementChild.textContent,'$.second');
  search.value = 'missing'; search.listeners.get('input')();
  assert.equal(elements.get('hiddenTemplateEmpty').hidden,false);
  search.value = '$.second'; search.listeners.get('input')();
  list.firstElementChild.children[1].click();
  assert.deepEqual(JSON.parse(storage.get(key)).hidden,['$.other']);
});

test('the blank canvas menu masks and restores rules for the active file only', async () => {
  const {api,elements} = reader();
  api.setTemplate({paths:[],hidden:['$["合同输出删除"]','$[0].secret','$[0]["a.b"]'],savedAt:1});
  const text = '{"other":0}\n{"secret":1,"a.b":null}\n';
  const first = api.buildDoc(text,'first.jsonl',text.length);
  const second = api.buildDoc('{"secret":2}','second.json',12);
  api.add(first); api.add(second); api.activateDoc(first.id);
  const source = first.source;
  const readPage = source.getChildren.bind(source);
  source.getChildren = (path, options) => readPage(path, {...options,limit:1});
  Object.assign(elements.get('ctxMenu'),{offsetWidth:160,offsetHeight:170});
  elements.get('viewport').listeners.get('contextmenu')({
    clientX:30,clientY:45,target:{closest:()=>null},preventDefault(){},stopPropagation(){}
  });
  assert.equal(elements.get('canvasMenu').hidden,false);
  assert.equal(elements.get('ctxMenu').style.left,'30px');
  elements.get('ctxCanvasRules').click();
  assert.equal(elements.get('canvasRulesDialog').open,true);
  await new Promise(resolve => setImmediate(resolve));
  const list = elements.get('canvasRulesList');
  assert.deepEqual(list.children.map(row => row.firstElementChild.textContent), ['$[0].secret','$[0]["a.b"]']);
  const row = list.firstElementChild;
  const mask = row.children[1];
  mask.click();
  assert.equal(first.maskedHiddenRules.has('$[0].secret'),true);
  assert.equal(mask.textContent,'取消屏蔽');
  assert.equal(elements.get('canvasRulesDialog').open,true);
  mask.click();
  assert.equal(first.maskedHiddenRules.has('$[0].secret'),false);
  mask.click();
  api.activateDoc(second.id);
  assert.equal(elements.get('canvasRulesDialog').open,false);
  assert.equal(second.maskedHiddenRules,undefined);
});

test('switching files preserves unapplied template changes on the originating tab', async () => {
  const {api,elements} = reader();
  const first = api.buildDoc('{"secret":1}', 'first.json', 12);
  const second = api.buildDoc('{"secret":2}', 'second.json', 12);
  api.add(first); api.add(second); api.activateDoc(first.id);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const checkbox = () => elements.get('editorTree').querySelectorAll('.ed-check')
    .find(control=>!control.disabled);
  api.openEditor(); await tick();
  checkbox().checked = false;
  checkbox().listeners.get('change')();
  api.activateDoc(second.id);
  api.openEditor(); await tick();
  assert.equal(checkbox().checked,true);
  api.activateDoc(first.id);
  api.openEditor(); await tick();
  assert.equal(checkbox().checked,false);
  elements.get('editorSaveBtn').click();
  assert.deepEqual(Array.from(api.template().hidden),['$.secret']);
});

test('undo and redo restore the expansion state of tree edits', async () => {
  const {api,elements,flush} = reader();
  const doc = api.buildDoc('{"a":{"b":{"c":1}}}', 'tree.json', 19);
  api.add(doc); api.activateDoc(doc.id);
  await flush();
  const tree = elements.get('tree');
  await api.expandByPaths(['$','$.a','$.a.b'],{exact:true});
  const open = () => tree.querySelectorAll('.tree-node.open').map(node=>node.dataset.path);
  const node = tree.querySelectorAll('.tree-node').find(node=>node.dataset.path==='$.a');
  api.beginNodeEdit(node);
  elements.get('valueEditType').value = 'number';
  elements.get('valueEditText').value = '2';
  api.applyNodeEdit(); await flush();
  assert.equal(doc.parsed.a,2);
  assert.deepEqual(open(),['$']);
  elements.get('undoEditBtn').click(); await flush();
  assert.deepEqual(open(),['$','$.a','$.a.b']);
  elements.get('redoEditBtn').click(); await flush();
  assert.equal(doc.parsed.a,2);
  assert.deepEqual(open(),['$']);
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
  api.configure({ largeFileThresholdMiB: 32, limitIdeComplexity: false });
  await api.loadFile({ path: 'D:/large.json' });
  const doc = api.state().doc;
  assert.equal(doc.source, indexed); assert.equal(doc.parsed, undefined); assert.equal(doc.text, '');
  assert(doc.sub.includes('索引模式'));
  assert.equal(elements.get('switchViewBtn').disabled, true);
  api.configure({ largeFileThresholdMiB: 64 });
  api.activateDoc(doc.id);
  assert.equal(elements.get('switchViewBtn').disabled, true);
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
      postMessage(payload, transfer) {
        assert.equal(transfer[0], payload.bytes);
        const text = new TextDecoder().decode(payload.bytes);
        this.onmessage({data:{result:parseDocument(text, payload.name), text}});
      }
    },
    statNativeFile: async path => ({ path, name: 'normal.json', size: 32 * 1024 ** 2 }),
    readNativeFile: async (path, maxBytes) => { read++; assert.equal(maxBytes, 32 * 1024 ** 2); return new TextEncoder().encode('{"ok":true}').buffer; },
    openIndexedFile: () => { throw new Error('must not index at the threshold'); }
  });
  api.configure({ largeFileThresholdMiB: 32 });
  await api.loadFile({ path: 'D:/normal.json' });
  assert.equal(read, 1); assert.equal(api.state().doc.parsed.ok, true);
});

test('native IDE retains original source text and reopening clears the previous draft', async () => {
  const original='{ "ok": true }';
  const {api,elements}=reader(new Map(), {
    URL,
    Worker: class {
      terminate() {}
      postMessage(payload) {
        assert.equal(payload.keepText, true);
        const text = new TextDecoder().decode(payload.bytes);
        this.onmessage({data:{result:parseDocument(text,payload.name),text}});
      }
    },
    statNativeFile: async path => ({path,name:'normal.json',size:original.length}),
    readNativeFile: async () => new TextEncoder().encode(original).buffer
  });
  api.configure({viewMode:'ide'});await api.loadFile({path:'D:/normal.json'});
  assert.equal(elements.get('ideInput').value,original);
  const first=api.state().doc;
  elements.get('ideInput').value='{"ok":false}';api.applyIdeChange('{"ok":false}');
  first.dirty=false;
  await api.loadFile({path:'D:/normal.json'});
  assert.equal(api.state().doc.id,first.id);
  assert.equal(elements.get('ideInput').value,original);
  assert.equal(first.ideDraft,undefined);
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
  api.activateDoc(doc.id); assert.equal(elements.get('expandAllBtn').textContent, '展开全部');
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

test('the IDE complexity switch allows complex memory files but respects the size threshold', async () => {
  const {api,elements,storage} = reader();
  api.configure({largeFileThresholdMiB:32, viewMode:'ide'});
  let parsedInWorker = false;
  const oversized = {name:'browser.json',size:32 * 1024 ** 2 + 1,text(){ parsedInWorker = true; }};
  await api.loadFile(oversized);
  assert.equal(api.allDocs().length,0);
  assert.equal(parsedInWorker,false);

  const doc = api.buildDoc(JSON.stringify(Array(10001).fill(0)), 'complex.json', 32 * 1024 ** 2);
  api.add(doc); api.activateDoc(doc.id);
  assert.equal(elements.get('switchViewBtn').disabled,true);
  const toggle = elements.get('optLimitIdeComplexity');
  toggle.listeners.get('change')({target:{checked:false}});
  assert.equal(elements.get('ideView').hidden,false);
  doc.size++;
  api.activateDoc(doc.id);
  assert.equal(elements.get('ideView').hidden,true);
  assert.equal(elements.get('switchViewBtn').disabled,true);
  const restored = reader(storage);
  restored.elements.get('settingsBtn').click();
  assert.equal(restored.elements.get('optLimitIdeComplexity').checked,false);
});

test('rapid settings changes update IDE availability on close without rebuilding the current tree', () => {
  const {api,elements,storage} = reader();
  const doc = api.buildDoc(JSON.stringify(Array(10001).fill(0)), 'complex.json', 75 * 1024 ** 2);
  api.configure({largeFileThresholdMiB:128});
  api.add(doc); api.activateDoc(doc.id);
  const root = elements.get('tree').firstElementChild;
  const toggle = elements.get('optLimitIdeComplexity');
  const switchView = elements.get('switchViewBtn');
  elements.get('settingsBtn').click();
  for(const checked of [false, true, false]) toggle.listeners.get('change')({target:{checked}});
  assert.equal(switchView.disabled,true);
  assert.equal(JSON.parse(storage.get('json-atlas_settings_v1')).limitIdeComplexity,false);
  elements.get('settingsClose').click();
  assert.equal(switchView.disabled,false);
  assert.equal(elements.get('tree').firstElementChild,root);
  assert.equal(elements.get('ideView').hidden,true);

  elements.get('settingsBtn').click();
  const select = elements.get('optLargeFileThreshold');
  for(const value of ['256', '64']){ select.value = value; select.listeners.get('change')(); }
  assert.equal(switchView.disabled,false);
  elements.get('settingsClose').click();
  assert.equal(switchView.disabled,true);
  assert.equal(elements.get('tree').firstElementChild,root);
});

test('JSONL settings coalesce native reconfiguration and skip changes that are reversed', async () => {
  const calls = [];
  let finish;
  const {api,elements} = reader();
  const doc = api.buildDoc('{"a":1}\n{"b":2}', 'logs.jsonl', 96 * 1024 ** 2);
  const info = wrap => ({kind:'jsonl',records:2,badCount:0,commentCount:0,
    root:{type:wrap ? 'array' : 'object',childCount:wrap ? 2 : 1,path:[]}});
  doc.source = new IndexedDataSource((op, id, {wrap}) => {
    assert.equal(op,'info');
    calls.push(wrap);
    return new Promise(resolve => { finish = () => resolve(info(wrap)); });
  }, 'indexed-logs', info(true));
  api.add(doc); api.activateDoc(doc.id);
  const set = (id,checked) => {
    const toggle = elements.get(id);
    toggle.checked = checked;
    toggle.listeners.get('change')({target:toggle});
  };
  const open = () => elements.get('settingsBtn').click();
  const close = () => elements.get('settingsClose').click();
  const wrap = checked => set('optSettingsJsonlArray',checked);
  const strict = checked => set('optStrictJsonl',checked);
  open(); wrap(false); wrap(true); close();
  assert.deepEqual(calls,[]);
  open(); wrap(false); strict(true); strict(false); strict(true);
  assert.deepEqual(calls,[]);
  close();
  assert.deepEqual(calls,[false]);
  open(); wrap(true); close();
  assert.deepEqual(calls,[false]);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls,[false,true]);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.source.wrap,true);
});


test('editing updates search source, undo restores the original and shortcuts stay opt-in', async () => {
  const {api,elements,keyListeners}=reader();
  const doc=api.buildDoc('{"old":1}', 'edit.json',9); api.add(doc); api.activateDoc(doc.id);
  const root=elements.get('tree').firstElementChild;
  api.beginNodeEdit(root);
  elements.get('valueEditType').value='object'; elements.get('valueEditText').value='{"new":2}';
  api.applyNodeEdit(); assert.equal(doc.parsed.new,2); assert.equal(doc.dirty,true);
  await api.searchTree('new'); assert.equal(elements.get('searchCount').textContent,'1 / 1');
  elements.get('undoEditBtn').listeners.get('click')(); assert.equal(doc.parsed.old,1); assert.equal(doc.dirty,false);
  const viewport=elements.get('viewport');
  const press=key=>keyListeners.get('keydown')({key,target:viewport,preventDefault(){}});
  press('i'); assert.equal(elements.get('viewer').classList.contains('editing'),false);
  api.configure({vimEditing:true}); press('i'); assert.equal(elements.get('viewer').classList.contains('editing'),true);
  assert.equal(elements.get('editModeStatus').hidden,false);
  assert.equal(elements.get('toast').textContent,'已进入编辑模式');
  press('Escape'); assert.equal(elements.get('viewer').classList.contains('editing'),false);
  assert.equal(elements.get('editModeStatus').hidden,true);
  assert.equal(elements.get('toast').textContent,'已返回阅读模式');
});


test('IDE settings, search, manual switching and edits share the active revision', async () => {
  const {api,elements,keyListeners}=reader();
  api.configure({viewMode:'auto'});
  const doc=api.buildDoc('{"count":1,"message":"hello"}','simple.json',30);
  api.add(doc);api.activateDoc(doc.id);
  assert.equal(elements.get('ideView').hidden,false);
  assert.equal(elements.get('viewport').hidden,true);
  await api.searchTree('hello');
  assert.equal(elements.get('searchCount').textContent,'1 / 1');
  assert.equal(elements.get('ideLines').querySelectorAll('.current-match').length,1);
  elements.get('switchViewBtn').listeners.get('click')();
  assert.equal(elements.get('ideView').hidden,true);
  api.beginNodeEdit(elements.get('tree').firstElementChild);
  elements.get('valueEditType').value='object'; elements.get('valueEditText').value='{"count":2}';api.applyNodeEdit();
  elements.get('switchViewBtn').listeners.get('click')();
  assert.equal(elements.get('ideView').hidden,false);
  assert.equal(doc.parsed.count,2);
  elements.get('undoEditBtn').listeners.get('click')();
  await api.searchTree('hello');
  assert.equal(elements.get('searchCount').textContent,'1 / 1');
  doc.size=65*1024*1024;api.activateDoc(doc.id);
  assert.equal(elements.get('ideView').hidden,true);
  assert.equal(elements.get('switchViewBtn').disabled,true);
  keyListeners.get('keydown')({key:'F6',ctrlKey:true,shiftKey:true,target:elements.get('viewport'),preventDefault(){}});
  assert.equal(elements.get('toast').textContent,'大文件仅支持树形视图');
  assert.equal(elements.get('ideView').hidden,true);
});

test('IDE typing groups keep the starting revision and allow redo', () => {
  const {api,elements,keyListeners} = reader();
  api.configure({viewMode:'ide'});
  const original = '{"text":""}';
  const doc = api.buildDoc(original,'typing.json',original.length);
  api.add(doc); api.activateDoc(doc.id);
  const input = elements.get('ideInput');
  for(let count = 1; count <= 15; count++){
    input.value = JSON.stringify({text:'a'.repeat(count)});
    input.listeners.get('input')({target:input,inputType:'insertText'});
  }
  assert.equal(doc.editHistory.length,1);
  input.value = '{"text":"中文🧪"}';
  input.listeners.get('input')({target:input,inputType:'insertText'});
  const finished = doc.text;
  const bytes = Buffer.byteLength(finished);
  const railMeta = () => elements.get('fileRail').querySelectorAll('.file-tab-meta')[0].textContent;
  assert.ok(elements.get('fileSub').textContent.startsWith(`${bytes} B ·`));
  assert.ok(railMeta().endsWith(`${bytes} B`));
  const keydown = (key, extra = {}) => keyListeners.get('keydown')({
    key, target:input, ctrlKey:true, preventDefault(){}, ...extra
  });
  keydown('z');
  assert.equal(doc.text,original);
  assert.ok(railMeta().endsWith(`${Buffer.byteLength(original)} B`));
  keydown('y');
  assert.equal(doc.text,finished);
  assert.ok(railMeta().endsWith(`${bytes} B`));
  keydown('z');
  input.value = '{"text":"b"}';
  input.listeners.get('input')({target:input,inputType:'insertText'});
  keydown('z',{shiftKey:true});
  assert.equal(doc.text,'{"text":"b"}');
});

test('IDE drafts survive invalid syntax and file switches, formatting and zoom remain undoable and scoped', async () => {
  const {api,elements,keyListeners}=reader();api.configure({viewMode:'ide'});
  const doc=api.buildDoc('{"count":1}','edit.json',11);api.add(doc);api.activateDoc(doc.id);
  const input=elements.get('ideInput');input.value='{"count":';
  input.listeners.get('input')({target:input});
  assert.equal(doc.dirty,true);assert.ok(doc.ideError);assert.equal(doc.parsed.count,1);
  elements.get('switchViewBtn').click();assert.equal(elements.get('ideView').hidden,false);
  const other=api.buildDoc('{}','other.json',2);api.add(other);api.activateDoc(other.id);api.activateDoc(doc.id);
  assert.equal(input.value,'{"count":');
  input.value='{"count":2}';input.listeners.get('input')({target:input});assert.equal(doc.parsed.count,2);assert.equal(doc.ideError,'');
  api.formatIde();assert.equal(input.value,'{\n  "count": 2\n}\n');
  elements.get('undoEditBtn').click();assert.equal(input.value,'{"count":2}');
  const key=keyListeners.get('keydown');key({key:'=',ctrlKey:true,target:input,preventDefault(){}});assert.equal(doc.ideZoom,110);
  key({key:'0',ctrlKey:true,target:input,preventDefault(){}});assert.equal(doc.ideZoom,100);
  await api.searchTree('count');assert.equal(elements.get('searchCount').textContent,'1 / 1');
  elements.get('switchViewBtn').click();assert.equal(elements.get('ideView').hidden,true);assert.equal(doc.parsed.count,2);
});

test('JSONL first-record editing preserves later records and undo restores original text', () => {
  const {api,elements}=reader(); api.configure({jsonlWrapArray:false});
  const text='{"x":1}\n{"x":2}\n'; const doc=api.buildDoc(text,'rows.jsonl',20); api.add(doc); api.activateDoc(doc.id);
  api.beginNodeEdit(elements.get('tree').firstElementChild);
  elements.get('valueEditType').value='object';elements.get('valueEditText').value='{"x":9}';api.applyNodeEdit();
  assert.equal(doc.records[0].x,9);assert.equal(doc.records[1].x,2);
  assert.deepEqual(JSON.parse(doc.text.split('\n')[1]),{x:2});
  elements.get('undoEditBtn').listeners.get('click')();assert.equal(doc.text,text);
});

test('save shortcut writes the active revision and undo remains dirty relative to saved content', async () => {
  const writes = [];
  const {api, elements, keyListeners} = reader(new Map(), {
    desktop:true, guardEditedClose:async()=>{}, updateDocumentMenu(){},
    saveNativeDocument:async(...args)=>{ writes.push(args); }
  });
  api.configure({viewMode:'ide'});
  const doc = api.buildDoc('{"n":1}', 'save.json', 7); doc.path='C:\\save.json';
  api.add(doc); api.activateDoc(doc.id);
  api.applyIdeChange('{"n":2}');
  let prevented = false;
  keyListeners.get('keydown')({key:'s',ctrlKey:true,target:elements.get('ideInput'),preventDefault(){prevented=true;}});
  await new Promise(resolve=>setImmediate(resolve));
  assert(prevented); assert.deepEqual(writes[0], [doc.path, '{"n":2}', '{"n":1}']);
  assert.equal(doc.dirty,false); assert.equal(elements.get('saveBtn').disabled,true);
  elements.get('undoEditBtn').click(); assert.equal(doc.text,'{"n":1}'); assert.equal(doc.dirty,true);
  elements.get('redoEditBtn').click(); assert.equal(doc.text,'{"n":2}'); assert.equal(doc.dirty,false);
  elements.get('undoEditBtn').click();
  await api.saveCurrentDocument(); assert.equal(writes[1][2],'{"n":2}'); assert.equal(doc.dirty,false);
});

test('saving keeps later edits dirty, prevents overlapping writes, and preserves dirty state on errors', async () => {
  let release, fail = false, calls = 0;
  const {api} = reader(new Map(), {
    desktop:true, guardEditedClose:async()=>{}, updateDocumentMenu(){},
    saveNativeDocument:async()=>{ calls++; if(fail) throw new Error('disk error'); await new Promise(resolve=>{release=resolve;}); }
  });
  api.configure({viewMode:'ide'});
  const doc=api.buildDoc('{"n":1}','save.json',7);doc.path='C:\\save.json';api.add(doc);api.activateDoc(doc.id);
  api.applyIdeChange('{"n":2}');
  const pending=api.saveCurrentDocument(); await api.saveCurrentDocument(); assert.equal(calls,1);
  api.applyIdeChange('{"n":3}'); release(); await pending;
  assert.equal(doc.dirty,true); assert.equal(doc.diskText,'{"n":2}');
  fail=true; await api.saveCurrentDocument(); assert.equal(doc.dirty,true); assert.equal(doc.saving,false);
  api.applyIdeChange('{'); await api.saveCurrentDocument(); assert.equal(calls,2);
});

test('IDEA shortcuts format, switch documents and open settings while respecting modal and text input focus', async () => {
  const {api,elements,keyListeners} = reader();
  api.configure({viewMode:'ide'});
  const first=api.buildDoc('{"n":1}','first.json',7), second=api.buildDoc('{}','second.json',2);
  api.add(first);api.add(second);api.activateDoc(first.id);
  const press = (key, extra={}) => keyListeners.get('keydown')({key,target:elements.get('ideInput'),preventDefault(){},...extra});
  press('l',{ctrlKey:true,altKey:true}); assert.equal(elements.get('ideInput').value,'{\n  "n": 1\n}\n');
  press('ArrowRight',{altKey:true}); assert.equal(api.state().activeDocId,second.id);
  press('ArrowLeft',{altKey:true}); assert.equal(api.state().activeDocId,first.id);
  const textField={closest:selector=>selector.includes('input,textarea') ? {} : null};
  press('ArrowRight',{altKey:true,target:textField}); assert.equal(api.state().activeDocId,first.id);
  press('s',{ctrlKey:true,altKey:true}); assert(elements.get('settingsMask').classList.contains('open'));
  press('ArrowRight',{altKey:true}); assert.equal(api.state().activeDocId,first.id);
  elements.get('settingsClose').click();
  press('ArrowRight',{altKey:true,isComposing:true}); assert.equal(api.state().activeDocId,first.id);
  api.activateDoc(second.id);
  press('F4',{ctrlKey:true}); assert.equal(api.state().activeDocId,first.id);
});

test('opt-in Vim keys navigate visible nodes, fold branches, and resume on the canvas after search', async () => {
  const {api,elements,keyListeners,flush} = reader();
  const raw = '{"branch":{"hitOne":1},"hitTwo":2}';
  const doc = api.buildDoc(raw,'vim.json',raw.length);
  api.configure({defaultLevels:1}); api.add(doc); api.activateDoc(doc.id);
  await flush();
  const tree = elements.get('tree'), viewport = elements.get('viewport');
  const selected = () => tree.querySelectorAll('.selected-node')[0]?.dataset.path;
  const press = (key, extra = {}) => {
    let handled = false;
    keyListeners.get('keydown')({key,target:viewport,preventDefault(){ handled = true; },...extra});
    return handled;
  };
  assert.equal(press('j'),false);
  elements.get('optVimEditing').checked = true;
  elements.get('optVimEditing').listeners.get('change')({target:elements.get('optVimEditing')});
  assert.equal(press('j'),true); assert.equal(selected(),'$.branch');
  assert(!tree.classList.contains('show-node-selection'));
  const outline = elements.get('optNodeSelectionStyle');
  outline.listeners.get('change')({target:{checked:true}});
  assert(tree.classList.contains('show-node-selection'));
  outline.listeners.get('change')({target:{checked:false}});
  assert(!tree.classList.contains('show-node-selection'));
  assert.equal(selected(),'$.branch');
  press('l'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(selected(),'$.branch.hitOne');
  press('h'); assert.equal(selected(),'$.branch');
  press('z'); press('c'); press('j'); assert.equal(selected(),'$.hitTwo');
  press('k'); assert.equal(selected(),'$.branch');
  press('g'); press('g'); assert.equal(selected(),'$');
  press('G'); assert.equal(selected(),'$.hitTwo');
  press('z'); press('Shift',{shiftKey:true}); press('M',{shiftKey:true});
  assert.equal(selected(),'$');
  assert.equal(tree.firstElementChild.classList.contains('open'),false);

  let canvasFocused = false;
  viewport.focus = () => { canvasFocused = true; };
  press('/'); assert.equal(elements.get('findPanel').hidden,false);
  await api.searchTree('hit'); assert.equal(selected(),'$.branch.hitOne');
  elements.get('closeFindBtn').click(); assert.equal(canvasFocused,true);
  press('n'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(selected(),'$.hitTwo');
  press('N'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(selected(),'$.branch.hitOne');
  assert.equal(press('j',{isComposing:true}),false);
  assert.equal(press('r',{target:elements.get('quickSearchInput')}),false);
  press('r'); assert.equal(elements.get('valueEditDialog').open,true);
});

test('new topics stay untyped through draft restore and can gain an explicit or structural type', async () => {
  const storage = new Map();
  const {api, elements, flush} = reader(storage);
  const tree = elements.get('tree');
  const badge = node => node._card.querySelectorAll('.badge')[0].textContent;
  const add = node => node._card.children.find(child => child.className === 'topic-add').click();
  const selected = () => tree.querySelectorAll('.selected-node')[0];
  elements.get('newDocBtn').click();
  await flush();
  add(tree.firstElementChild);
  await flush();
  assert.equal(badge(selected()), '未指定类型');
  const reopened = reader(storage);
  await reopened.flush();
  const restoredChild = reopened.elements.get('tree').querySelectorAll('.tree-node')[1];
  assert.equal(badge(restoredChild), '未指定类型');

  api.beginNodeEdit(selected());
  const type = elements.get('valueEditType');
  assert.equal(type.value, '');
  assert.equal(elements.get('valueEditText').value, '');
  assert.throws(() => api.applyNodeEdit(), /请选择值类型/);
  type.value = 'object';
  type.listeners.get('change')({target:type});
  api.applyNodeEdit();
  await flush();
  assert.equal(badge(selected()), 'Object · 0');
  elements.get('undoEditBtn').click();
  await flush();
  assert.equal(badge(selected()), '未指定类型');

  add(selected());
  await flush();
  assert.equal(badge(tree.querySelectorAll('.tree-node')[1]), 'Object · 1');
  assert.equal(badge(selected()), '未指定类型');
});

test('existing JSON files can enter design mode while the larger files remain editable normally', async () => {
  const {api,elements,storage,flush} = reader();
  const tree = elements.get('tree'), mode = elements.get('designModeBtn'), limit = elements.get('optDesignLimit');
  const existing = api.buildDoc('{"old":1}', 'existing.json', 9);
  const boundary = api.buildDoc('{}', 'boundary.json', 8 * 1024 ** 2);
  const large = api.buildDoc('{}', 'large.json', 32 * 1024 ** 2);
  for(const doc of [existing,boundary,large]) api.add(doc);
  api.activateDoc(existing.id);
  mode.click();
  await flush();
  assert.equal(existing.design,true);
  assert.equal(elements.get('viewer').classList.contains('designing'),true);
  assert.equal(elements.get('editModeBtn').hidden,true);
  tree.firstElementChild._card.children.find(child => child.className === 'topic-add').click();
  await flush();
  assert.deepEqual(JSON.parse(existing.text),{old:1,子主题:{}});
  mode.click();
  await flush();
  assert.equal(existing.design,false);
  assert.equal(elements.get('editModeBtn').disabled,false);
  assert.ok([...storage.keys()].some(key => key.startsWith('json-atlas_design-draft_v1:')));

  api.activateDoc(boundary.id);
  assert.equal(mode.disabled,true);
  assert.equal(elements.get('editModeBtn').disabled,false);
  limit.value = '16';
  limit.listeners.get('change')();
  assert.equal(mode.disabled,false);
  mode.click();
  assert.equal(boundary.design,true);
  limit.value = '8';
  limit.listeners.get('change')();
  assert.equal(boundary.design,false);
  assert.equal(mode.disabled,true);
  limit.value = '64';
  limit.listeners.get('change')();
  assert.equal(limit.value,'32');
  api.activateDoc(large.id);
  assert.equal(mode.disabled,true);
  assert.equal(elements.get('editModeBtn').disabled,false);
});

test('blank documents edit typed values and manipulate array elements on the canvas', async () => {
  const {api,elements,keyListeners,flush} = reader();
  elements.get('newDocBtn').click();
  await flush();
  const tree = elements.get('tree');
  const selected = () => tree.querySelectorAll('.selected-node')[0];
  const onCard = node => ({closest: selector => ({'.node-card':{closest:() => node}, '.tree-node':node})[selector]});
  const input = elements.get('valueEditText'), type = elements.get('valueEditType');
  const edit = (nextType, value) => {
    type.value = nextType;
    type.listeners.get('change')({target:type});
    if(value !== undefined) input.value = value;
    elements.get('valueEditForm').listeners.get('submit')({preventDefault(){}});
    assert.equal(elements.get('valueEditError').textContent,'');
  };
  const press = key => keyListeners.get('keydown')({key,target:elements.get('viewport'),preventDefault(){}});
  const openMenu = node => tree.listeners.get('contextmenu')({
    target:onCard(node), preventDefault(){}, stopPropagation(){}, clientX:100, clientY:100
  });
  const parsed = () => JSON.parse(api.state().doc.text);

  selected()._card.children.find(child => child.className === 'topic-add').click();
  await flush();
  tree.listeners.get('dblclick')({target:onCard(selected())});
  assert.equal(elements.get('designTopicDialog').open,true);
  elements.get('designTopicCancel').click();
  elements.get('undoEditBtn').click();
  await flush();
  const doubleClick = elements.get('optTopicDoubleClick');
  doubleClick.listeners.get('change')({target:{value:'value'}});

  openMenu(selected());
  elements.get('ctxTopicValue').click();
  assert.equal(elements.get('valueEditDialog').open,true);
  edit('array');
  await flush();
  assert.deepEqual(parsed(),[]);

  selected()._card.children.find(child => child.className === 'topic-add').click();
  await flush();
  assert.deepEqual(parsed(),[null]);
  assert.equal(selected().dataset.path,'$[0]');
  tree.listeners.get('dblclick')({target:onCard(selected())});
  assert.equal(elements.get('valueEditDialog').open,true);
  edit('number','42');
  await flush();
  assert.deepEqual(parsed(),[42]);
  assert.equal(selected().dataset.path,'$[0]');

  press('Enter');
  await flush();
  assert.equal(selected().dataset.path,'$[1]');
  openMenu(selected());
  assert.equal(elements.get('ctxTopicRename').disabled,true);
  elements.get('ctxTopicValue').click();
  edit('object','{"nested":{"deep":true}}');
  await flush();
  await api.expandOne(selected());
  assert.equal(selected().classList.contains('open'),true);
  api.selectCopyNode(tree.querySelectorAll('.tree-node').find(node => node.dataset.path === '$[0]'));
  press('Delete');
  await flush();
  assert.deepEqual(parsed(),[{nested:{deep:true}}]);
  assert.equal(tree.querySelectorAll('.tree-node.open').some(node => node.dataset.path === '$[0]'),true);
  elements.get('undoEditBtn').click();
  await flush();
  assert.deepEqual(parsed(),[42,{nested:{deep:true}}]);
  assert.equal(tree.querySelectorAll('.tree-node.open').some(node => node.dataset.path === '$[1]'),true);
});

test('Vim commands in blank documents add, rename, delete and undo topics', async () => {
  const {api,elements,keyListeners,flush} = reader();
  api.configure({vimEditing:true});
  elements.get('newDocBtn').click(); await flush();
  const press = key => keyListeners.get('keydown')({key,target:elements.get('viewport'),preventDefault(){}});
  const submit = async name => {
    elements.get('designTopicName').value = name;
    elements.get('designTopicForm').listeners.get('submit')({preventDefault(){}});
    await flush();
  };
  press('a'); await submit('first');
  press('o'); await submit('second');
  press('i'); await submit('renamed');
  press('d'); press('Escape'); press('d');
  assert.equal(Object.hasOwn(api.state().doc.parsed,'renamed'),true);
  press('d'); await flush();
  assert.equal(Object.hasOwn(api.state().doc.parsed,'renamed'),false);
  press('u'); await flush();
  assert.equal(Object.hasOwn(api.state().doc.parsed,'renamed'),true);
});

test('tree folding and undo shortcuts preserve ordinary text editing', async () => {
  const {api,elements,keyListeners}=reader();
  const doc=api.buildDoc('{"a":1}','tree.json',7);api.add(doc);api.activateDoc(doc.id);
  elements.get('tree').firstElementChild.isConnected=true;
  elements.get('tree').querySelector=()=>null;
  const press=(key,extra={})=>keyListeners.get('keydown')({key,target:elements.get('viewport'),preventDefault(){},...extra});
  press('+',{code:'NumpadAdd',ctrlKey:true,shiftKey:true});await new Promise(resolve=>setImmediate(resolve));
  assert(elements.get('tree').firstElementChild.classList.contains('open'));
  press('-',{code:'NumpadSubtract',ctrlKey:true,shiftKey:true});assert(!elements.get('tree').firstElementChild.classList.contains('open'));
  api.beginNodeEdit(elements.get('tree').firstElementChild);
  elements.get('valueEditType').value='object';elements.get('valueEditText').value='{"b":2}';api.applyNodeEdit();
  press('z',{ctrlKey:true,target:{closest:()=>({})}});assert.equal(doc.parsed.b,2);
  press('z',{ctrlKey:true});assert.equal(doc.parsed.a,1);
});

test('macOS hints and shortcuts use Command and platform specific settings and tab keys', () => {
  const {api,elements,keyListeners}=reader(new Map(),{navigator:{platform:'MacIntel'}});
  assert.equal(elements.get('openShortcutModifier').textContent,'⌘');
  assert.equal(elements.get('findShortcutLabel').textContent,'⌘+F');
  assert.equal(elements.get('saveBtn').title,'保存修改（⌘+S）');
  assert(!elements.get('shortcutHelp').children.some(el=>el.children[0]?.textContent.includes('Ctrl')));
  const first=api.buildDoc('{}','first.json',2),second=api.buildDoc('{}','second.json',2);
  api.add(first);api.add(second);api.activateDoc(first.id);
  const press=(key,extra={})=>keyListeners.get('keydown')({key,target:elements.get('viewport'),preventDefault(){},...extra});
  press('}',{code:'BracketRight',metaKey:true,shiftKey:true});assert.equal(api.state().activeDocId,second.id);
  press(',',{metaKey:true});assert(elements.get('settingsMask').classList.contains('open'));
});

function pastedReader(extra = {}) {
  return reader(new Map(), {
    desktop:true, URL, updateDocumentMenu(){}, guardEditedClose:async()=>{},
    Worker:class {
      terminate() {}
      async postMessage(payload) {
        const text = await payload.file.text();
        this.onmessage({data:{result:parseDocument(text,payload.name),text:payload.keepText ? text : null}});
      }
    }, ...extra
  });
}

test('pasting JSON and JSONL creates distinct unsaved documents and retains original text on desktop', async () => {
  const {api,elements} = pastedReader();
  const text = '{ "a": 1 }';
  await api.openPastedText(text);
  const first = api.state().doc;
  assert.equal(first.text,text); assert.equal(first.temporary,true); assert.equal(first.dirty,true);
  assert.equal(first.path,null); assert.equal(elements.get('saveBtn').disabled,false);
  await api.openPastedText(text);
  assert.equal(api.allDocs().length,2); assert.notEqual(api.state().doc.name,first.name);
  await api.openPastedText('{"a":1}\n{"a":2}\n');
  assert.equal(api.state().doc.kind,'jsonl'); assert.match(api.state().doc.name,/\.jsonl$/);
  assert.equal(api.state().doc.records.length,2);
  await api.openPastedText('  '); await api.openPastedText('not JSON');
  assert.equal(api.allDocs().length,3);
  api.configure({viewMode:'ide'}); api.activateDoc(first.id);
  api.handleIdeInput('{"a":2}'); elements.get('undoEditBtn').click();
  assert.equal(first.text,text); assert.equal(first.dirty,true,'undo must not mark an unsaved temporary file as saved');
});

test('temporary first save cancellation/failure retains state, successful save binds path and later saves write there', async () => {
  let outcome = null; const copies=[], writes=[];
  const {api,elements,storage} = pastedReader({
    saveDocumentCopy:async(...args)=>{ copies.push(args); if(outcome instanceof Error) throw outcome; return outcome; },
    saveNativeDocument:async(...args)=>writes.push(args)
  });
  api.configure({reopenLast:true,viewMode:'ide'});
  await api.openPastedText('{"a":1}'); const doc=api.state().doc;
  await api.saveCurrentDocument(); assert.equal(doc.temporary,true); assert.equal(doc.path,null); assert.equal(doc.dirty,true);
  outcome = new Error('write failed'); await api.saveCurrentDocument();
  assert.equal(doc.path,null); assert.equal(doc.dirty,true); assert.equal(doc.saving,false);
  outcome = 'C:\\saved\\clipboard.json'; await api.saveCurrentDocument();
  assert.equal(doc.path,outcome); assert.equal(doc.name,'clipboard.json'); assert.equal(doc.temporary,false); assert.equal(doc.dirty,false);
  assert.equal(doc.diskText,'{"a":1}'); assert.equal(doc.identity,outcome.toLowerCase());
  assert.equal(copies[2][0],'未命名-1.json');
  assert([...storage.values()].some(value=>value.includes('clipboard.json')));
  api.handleIdeInput('{"a":2}'); await api.saveCurrentDocument();
  assert.deepEqual(writes[0],[outcome,'{"a":2}','{"a":1}']);
  assert.equal(copies.length,3); assert.equal(doc.dirty,false);
  assert.equal(elements.get('fileName').title,outcome);
});

test('paste shortcut preserves text controls and dialogs without actively reading the clipboard', async () => {
  let reads=0;
  const {api,elements,keyListeners} = pastedReader({navigator:{platform:'Win32',clipboard:{readText:async()=>{reads++;throw new Error('must not request clipboard permission')}}}});
  const paste=keyListeners.get('paste'); let prevented=false;
  const event=target=>({target,clipboardData:{getData:()=>'{"a":1}'},preventDefault(){prevented=true;}});
  paste(event({closest:()=>({})}));
  assert.equal(prevented,false); assert.equal(api.allDocs().length,0);
  elements.get('valueEditDialog').showModal();
  paste(event({closest:()=>null})); assert.equal(prevented,false);
  elements.get('valueEditDialog').close();
  paste(event({closest:()=>null}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(prevented,true); assert.equal(api.allDocs().length,1); assert.equal(reads,0);
});

test('IDE fold icon visibility is optional, immediate and retained after reopening settings and restart', () => {
  const {elements,storage,keyListeners} = reader();
  assert.equal(elements.get('ideView').classList.contains('ide-fold-always-visible'),false);
  const toggle=elements.get('optIdeFoldAlwaysVisible');
  toggle.checked=true;toggle.listeners.get('change')({target:toggle});
  assert.equal(elements.get('ideView').classList.contains('ide-fold-always-visible'),true);
  keyListeners.get('keydown')({key:'s',ctrlKey:true,altKey:true,preventDefault(){}});
  assert.equal(toggle.checked,true);
  const restarted=reader(storage);
  assert.equal(restarted.elements.get('ideView').classList.contains('ide-fold-always-visible'),true);
  const restored=restarted.elements.get('optIdeFoldAlwaysVisible');
  restored.checked=false;restored.listeners.get('change')({target:restored});
  assert.equal(restarted.elements.get('ideView').classList.contains('ide-fold-always-visible'),false);
});

test('copy path works on leaf nodes and copies the exact encoded JSON path', async () => {
  const copied=[];
  const {api,elements}=reader(new Map(),{
    navigator:{platform:'Win32',clipboard:{writeText:async text=>copied.push(text)}}
  });
  const doc=api.buildDoc('{"a.b":1}','path.json',9);api.add(doc);api.activateDoc(doc.id);
  Object.assign(elements.get('ctxMenu'),{offsetWidth:160,offsetHeight:220});
  const root=elements.get('tree').firstElementChild; await root._ensureChildren();
  const leaf=elements.get('tree').querySelectorAll('.tree-node').find(node=>node.dataset.path==='$["a.b"]');
  assert(leaf);
  elements.get('tree').listeners.get('contextmenu')({target:{closest:()=>({closest:()=>leaf})},clientX:20,clientY:20,preventDefault(){},stopPropagation(){}});
  assert.equal(elements.get('ctxCopyPath').disabled,false);
  assert.equal(elements.get('ctxMenu').style.left,'20px');
  await elements.get('ctxCopyPath').listeners.get('click')();
  assert.deepEqual(copied,['$["a.b"]']);
});

test('selecting a card enables Ctrl+C for its full contents, without stealing ordinary text copy', async () => {
  const copied=[];let textSelected=false;
  const {api,elements,keyListeners}=reader(new Map(),{
    navigator:{platform:'Win32',clipboard:{writeText:async text=>copied.push(text)}},
    window:{innerWidth:1440,innerHeight:900,addEventListener(){},getSelection:()=>({isCollapsed:!textSelected})}
  });
  const doc=api.buildDoc('{"text":"hello","number":42}','copy.json',28);api.add(doc);api.activateDoc(doc.id);
  const root=elements.get('tree').firstElementChild;await root._ensureChildren();
  const leaf=elements.get('tree').querySelectorAll('.tree-node').find(node=>node.dataset.path==='$.text');
  const target={closest:selector=>selector==='.tree-node'?leaf:selector==='.node-card'?{}:null};
  elements.get('tree').listeners.get('pointerdown')({target});
  assert(leaf.classList.contains('selected-node'));
  const press=(extra={})=>{let prevented=false;keyListeners.get('keydown')({key:'c',ctrlKey:true,target:elements.get('viewport'),preventDefault(){prevented=true;},...extra});return prevented;};
  assert.equal(press(),true);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(copied,['hello']);
  assert.equal(press({target:{closest:()=>({})}}),false);
  textSelected=true;assert.equal(press(),false);textSelected=false;
  assert.equal(press({isComposing:true}),false);assert.equal(press({shiftKey:true}),false);
  elements.get('valueEditDialog').showModal();assert.equal(press(),false);elements.get('valueEditDialog').close();
  api.selectCopyNode(root);assert.equal(leaf.classList.contains('selected-node'),false);
  assert.equal(press(),true);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(JSON.parse(copied[1]),{text:'hello',number:42});
  api.selectCopyNode(null);assert.equal(press(),false);
  assert.equal(copied.length,2);
});

test('pending node copies cannot publish content after switching documents', async () => {
  const copied=[];let finish;
  const {api,elements,keyListeners}=reader(new Map(),{navigator:{platform:'Win32',clipboard:{writeText:async text=>copied.push(text)}}});
  const first=api.buildDoc('{}','first.json',2),second=api.buildDoc('{}','second.json',2);
  api.add(first);api.add(second);api.activateDoc(first.id);
  const node=elements.get('tree').firstElementChild;
  node._source.getText=()=>new Promise(resolve=>{finish=resolve;});api.selectCopyNode(node);
  let prevented=false;keyListeners.get('keydown')({key:'c',ctrlKey:true,target:elements.get('viewport'),preventDefault(){prevented=true;}});
  assert.equal(prevented,true);api.activateDoc(second.id);finish('{}');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(copied,[]);assert(!node.classList.contains('selected-node'));
});
