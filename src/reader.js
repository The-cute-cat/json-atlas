import { getLanguage, initializeLanguage, msg, normalizeLanguage, saveLanguage, t } from './i18n.js';
import manifest from '../package.json';
import { pagedChildren, discardPagedTree } from './paging.js';
import { MemoryDataSource } from './data-source.js';
import { sharedPageCache } from './page-cache.js';
import { normalizeThreshold, needsIndex } from './large-files.js';
import { ViewportWindow } from './viewport-window.js';
import { NodeBudget } from './node-budget.js';
import { compileSearch } from './search-pattern.js';
import { valueAt, replaceValue, editObjectTopic, parseEdit, serializeDocument } from './editing.js';
import { ideModel, renderIde, normalizeViewMode, parseIdeText, formatIdeText, ideTextLines, ideProjection, ideRawOffset, ideProjectedEdit } from './ide-view.js';
import { normalizeTheme, watchTheme } from './theme.js';
import { updateWindowTheme } from './desktop.js';
import { installTooltips } from './tooltips.js';
import { openAbout } from './about.js';
import { openUpdateCheck } from './update-dialog.js';
import { isMacPlatform, shortcutLabel, shortcutAction, shortcutAlternativeLabel } from './shortcuts.js';
import { MAX_FILE_BYTES, parseDocument, encodeDataPath as encodePath, normalizeDataPath as normalizePath } from './data.js';
import { updateDocumentMenu, saveNativeDocument, saveDocumentCopy, guardEditedClose, desktop, readNativeFile, statNativeFile, openIndexedFile, selectNativeFiles, updateWindowTitle, connectDesktop } from './desktop.js';

initializeLanguage(document);

let expansionGeneration = 0;
let templateEditing = false;
let restoringExpansion = null;
let searchTimer;
let searchGeneration = 0;
let focusGeneration = 0;
let searchTruncated = false;
let activeLoad = null;
const fileLoads = [];
let runningLoad = null, selectedLoad = null, loadSequence = 0, drainingLoads = false;
let wakeBackgroundLoad = null;
let pendingRailRefresh = false;
let editMode = false;
let vimPrefix = null;
let editingNode = null;
let designTopic = null;
let pendingTopicDeletion = null;
let topicAddButton = null;
let discardResolver = null;
let ideActive = false;
let ideLocations = new Map();
let ideActiveMarks = [];
let ideScopeCap = null;
function updateIdeScope(){
  ideScopeCap?.remove(); ideScopeCap = null;
  for(const [element, name] of ideActiveMarks) element.classList.remove(name);
  ideActiveMarks = [];
  const doc = activeDoc(), projection = doc?.ideProjection;
  if(!ideActive || !projection?.lines.length) return;
  const offset = document.getElementById('ideInput').selectionStart || 0;
  let index = 0;
  while(index + 1 < projection.offsets.length && projection.offsets[index + 1].visible <= offset) index++;
  const line = projection.lines[index].path[0], column = offset - projection.offsets[index].visible;
  const mark = (element, name) => { if(element){ element.classList.add(name); ideActiveMarks.push([element,name]); } };
  mark(doc.ideRows?.get(line), 'caret-line');
  const before = (a,b) => a.line < b.line || a.line === b.line && a.column <= b.column;
  const caret = {line,column};
  const pairs = doc.ideScopePairs || [];
  const touching = pairs.find(pair => [pair.start,pair.end].some(p => p.line === line && (p.column === column || p.column === column - 1)));
  const pair = touching || pairs.findLast(pair => before(pair.start,caret) && before(caret,pair.end));
  if(!pair) return;
  const first = doc.ideRows?.get(pair.start.line)?.children[1];
  if(first){
    ideScopeCap = document.createElement('span');
    ideScopeCap.className = `ide-scope-cap ide-bracket-${pair.colour}`;
    ideScopeCap.style.setProperty('--scope-indent', String(pair.indent));
    ideScopeCap.style.setProperty('--scope-width', String(Math.max(1,pair.start.column-pair.indent+1)));
    first.appendChild(ideScopeCap);
  }
  for(const point of [pair.start,pair.end]){
    const row = doc.ideRows?.get(point.line);
    const token = [...(row?.children[1]?.children || [])].find(el => el.dataset?.column === String(point.column) && el.classList.contains('ide-bracket-' + pair.colour));
    mark(token, 'ide-bracket-active');
  }
  for(const [original,row] of doc.ideRows || []){
    if(original <= pair.start.line || original > pair.end.line) continue;
    for(const guide of row.children[1]?.children || []) if(guide.classList?.contains('ide-guide') && guide.dataset.column === String(pair.indent)) mark(guide,'ide-guide-active');
  }
}
const macPlatform = isMacPlatform(navigator);
const primaryModifier = macPlatform ? '⌘' : 'Ctrl';
const shortcutText = action => shortcutLabel(action, macPlatform);
const MAX_EDIT_HISTORY = 50;
const MIN_EDIT_HISTORY = 10;
const EDIT_HISTORY_TEXT_BUDGET = 64 * 1024 * 1024;
function editRevision(doc, includeTreeState = false){
  return {parsed:doc.parsed, records:doc.records, dirty:!!doc.dirty, text:doc.text, editedSize:doc.editedSize,
    untypedTopics:doc.untypedTopics,
    ideDraft:doc.ideDraft, ideError:doc.ideError, bad:doc.bad, totalLines:doc.totalLines,
    ...(includeTreeState ? {openPaths:doc.openPaths, pageOffsets:doc.pageOffsets} : {})};
}
function setEditedText(doc, text, size = new Blob([text]).size){
  doc.text = text;
  doc.editedSize = size;
}
function rememberEdit(doc, inputType = null, includeTreeState = false){
  doc.ideFolds?.clear();
  doc.savedText ??= doc.text;
  doc.diskText ??= doc.text;
  const last = doc.ideEditGroup, now = Date.now();
  if(!inputType || last?.type !== inputType || now - last.time > 500){
    const history = doc.editHistory ||= [];
    history.push(editRevision(doc, includeTreeState));
    // Revisions keep full document text and may also retain an invalid IDE draft.
    let textBytes = 0;
    const maxSteps = Math.min(history.length, MAX_EDIT_HISTORY);
    for(let steps = 1; steps <= maxSteps; steps++){
      const {text, ideDraft} = history.at(-steps);
      textBytes += 2 * ((text?.length ?? 0) + (ideDraft !== text ? (ideDraft?.length ?? 0) : 0));
      if(steps >= MIN_EDIT_HISTORY && textBytes >= EDIT_HISTORY_TEXT_BUDGET){
        history.splice(0, history.length - steps);
        break;
      }
    }
    if(history.length > MAX_EDIT_HISTORY) history.shift();
  }
  doc.ideEditGroup = inputType ? {type:inputType, time:now} : null;
  doc.redoHistory = [];
}
function syncIdeScroll(){
  const input = document.getElementById('ideInput'), highlight = document.getElementById('ideHighlight');
  // Clip the overlay to the textarea's content viewport. Its raised gutter
  // must not paint over (or intercept) the textarea's native scrollbars.
  if(input.clientWidth > 0 && input.clientHeight > 0){
    highlight.style.width = `${input.clientWidth}px`;
    highlight.style.height = `${input.clientHeight}px`;
  }
  highlight.scrollTop = input.scrollTop; highlight.scrollLeft = input.scrollLeft;
}
function setIdeZoom(value){
  const doc = activeDoc(); if(!doc) return;
  doc.ideZoom = Math.min(200, Math.max(70, value));
  document.getElementById('ideView').style.setProperty('--ide-size', `${13 * doc.ideZoom / 100}px`);
  document.getElementById('ideView').style.setProperty('--ide-line-height', `${23 * doc.ideZoom / 100}px`);
  syncIdeScroll();
  scheduleSessionSave();
}
function renderIdeBuffer(doc){
  const text = doc.ideDraft ?? doc.text ?? '', lines = text.length > 2 * 1024 * 1024 ? [] : ideTextLines(text);
  const plain = text.length > 2 * 1024 * 1024 || lines.length > 20000;
  document.getElementById('ideView').classList.toggle('ide-plain', plain);
  doc.ideProjection = plain ? null : ideProjection(text, doc.ideFolds);
  const input = document.getElementById('ideInput');
  const projected = doc.ideProjection?.text ?? text;
  if(input.value !== projected) input.value = projected;
  ideLocations = renderIde(document.getElementById('ideLines'), doc.ideProjection?.lines || [], document, line => toggleIdeFold(line));
  doc.ideRows = new Map([...document.getElementById('ideLines').children].map(row => [Number(row.dataset.line)-1,row]));
  doc.ideScopePairs = (doc.ideProjection?.lines || []).flatMap(line => line.decoration.tokens
    .filter(token => token.partner && (token.text === '{' || token.text === '['))
    .map(token => ({start:{line:line.path[0],column:token.start},end:token.partner,
      colour:Number(token.className.slice(-1)),indent:line.text.match(/^[\t ]*/)[0].replaceAll('\t','  ').length})));
  const status = document.getElementById('ideStatus');
  status.textContent = doc.ideError ? t('语法错误：') + doc.ideError : plain ? t('大段文本已暂停高亮') : '';
  status.hidden = !status.textContent;
  status.title = status.textContent; status.classList.toggle('invalid', !!doc.ideError);
  syncIdeScroll();
  updateIdeScope();
}
function toggleIdeFold(line){
  const doc = activeDoc(); if(!ideActive || !doc?.ideProjection) return;
  const input = document.getElementById('ideInput'), scroll = input.scrollTop;
  const raw = ideRawOffset(doc.ideProjection, input.selectionStart || 0);
  doc.ideFolds ||= new Set();
  if(doc.ideFolds.has(line)) doc.ideFolds.delete(line); else doc.ideFolds.add(line);
  renderIdeBuffer(doc);
  let caret = 0;
  for(const row of doc.ideProjection.offsets) {
    if(row.raw > raw) break;
    caret = row.visible + Math.min(row.length, raw - row.raw);
  }
  input.setSelectionRange?.(caret, caret); input.scrollTop = scroll; syncIdeScroll();
  scheduleSessionSave();
}
function handleIdeInput(text, inputType){
  const doc = activeDoc(), input = document.getElementById('ideInput');
  if(!doc) return;
  if(doc.ideFolds?.size && doc.ideProjection){
    const result = ideProjectedEdit((doc.ideDraft ?? doc.text ?? '').replace(/\r\n/g,'\n'), doc.ideProjection, text);
    doc.ideFolds.clear();
    if(!result){ renderIdeBuffer(doc); showToast(t('已展开折叠内容，请继续编辑')); return; }
    applyIdeChange(result.text); input.setSelectionRange?.(result.caret, result.caret);
  } else applyIdeChange(text, inputType);
}
function applyIdeChange(text, inputType){
  const doc = activeDoc(); if(!doc || !ideActive || doc.source?.indexed || text === doc.text) return;
  const size = new Blob([text]).size;
  if(doc.design && size >= designLimitBytes()){
    renderIdeBuffer(doc);
    showToast(designLimitMessage());
    return;
  }
  const previousProblem = doc.ideError, previousCount = doc.records?.length;
  rememberEdit(doc, inputType);
  doc.ideFolds?.clear();
  doc.ideDraft = text; setEditedText(doc, text, size); doc.dirty = true;
  try {
    Object.assign(doc, parseIdeText(text, doc.kind)); doc.ideError = '';
    doc.untypedTopics = undefined;
    const resolved = resolveDoc(doc); doc.data = resolved.data; parsedData = doc.data;
    // Tree rendering refreshes its source when switching back; IDE search uses raw lines.
  } catch(error){ doc.ideError = error.message; }
  persistDesignDraft(doc);
  searchGeneration++; focusGeneration++; matches = []; currentMatchIndex = -1;
  setSearchCount(''); nextMatchBtn.disabled = true; prevMatchBtn.disabled = true;
  renderIdeBuffer(doc); updateDocHeader(doc); syncEditing();
  if(previousProblem !== doc.ideError || previousCount !== doc.records?.length) renderRail();
  else updateRailFileDetails(doc);
  if(searchInput.value){ clearTimeout(searchTimer); searchTimer = setTimeout(() => searchTree(searchInput.value), 180); }
}
function leaveIde(){
  const doc = activeDoc();
  if(ideActive && doc?.ideError){ showToast(t('请先修正 JSON 语法，再切换到树形视图')); return false; }
  return true;
}
function formatIde(){
  if(!ideActive) return;
  const doc = activeDoc(), input = document.getElementById('ideInput');
  try {
    const formatted = formatIdeText(doc.ideDraft ?? doc.text ?? '', doc.kind);
    doc.ideFolds?.clear();
    applyIdeChange(formatted);
    if(doc.text !== formatted) return;
    renderIdeBuffer(doc); input.value = formatted; syncIdeScroll(); input.focus();
  } catch(error){
    const status = document.getElementById('ideStatus');
    status.textContent = t('无法格式化：') + error.message; status.title = status.textContent; status.classList.add('invalid');
    status.hidden = false;
    showToast(t('无法格式化：') + error.message);
  }
}
function syncDocumentMenu(){
  if(!desktop) return;
  const doc = activeDoc();
  const actions = {'switch-view':'switchView','edit-mode':'editMode','design-mode':'designMode','undo-edit':'undo','redo-edit':'redo','format-json':'format'};
  updateDocumentMenu([
    ['switch-view','switchViewBtn'], ['edit-mode','editModeBtn'], ['design-mode','designModeBtn'],
    ['undo-edit','undoEditBtn'], ['redo-edit','redoEditBtn'], ['save','saveBtn'], ['save-copy','saveCopyBtn'], ['format-json','formatIdeBtn']
  ].map(([id, buttonId]) => {
    const button = document.getElementById(buttonId);
    if(id === 'save' && templateEditing) return {id, text:t('应用模板'), enabled:true};
    return {id, text:button.textContent, shortcut:actions[id] ? shortcutText(actions[id]) : null,
      enabled:!templateEditing && !!doc && !button.disabled && !(id === 'edit-mode' && ideActive)};
  }).concat([
    {id:'open',enabled:!templateEditing},
    {id:'new-document',enabled:!templateEditing},
    {id:'close',text:t('关闭当前文件'),shortcut:shortcutText('close'),enabled:!templateEditing && !!doc},
    {id:'find',enabled:!!doc},
    {id:'reset',text:t('重置视图'),shortcut:shortcutText('resetView'),enabled:!!doc && !doc.error},
    {id:'settings',text:t('设置…'),shortcut:shortcutText('settings'),enabled:!templateEditing},
    {id:'about',text:t('关于 JSON Atlas'),shortcut:macPlatform ? null : shortcutText('about'),enabled:!templateEditing},
    {id:'check-update',enabled:!templateEditing}
  ], macPlatform ? [copyNodeMenuState()] : []));
}

function resizeNodeEditor(){
  const dialog = document.getElementById('valueEditDialog');
  if(!dialog.open) return;
  const input = document.getElementById('valueEditText');
  // A short sample is enough to reach the width cap; avoid allocating an
  // additional character array for an entire large edited value on each key.
  const longest = input.value.slice(0,32768).split('\n').slice(0,200).reduce((max, line) => Math.max(max, [...line.slice(0,100)].reduce((length, c) => length + (c.charCodeAt(0) > 255 ? 2 : 1), 0)), 0);
  const type = document.getElementById('valueEditType').value;
  const maxWidth = ['object','array'].includes(type) ? 640 : 520;
  dialog.style.width = `${Math.min(Math.max(360, longest * 7.5 + 80), maxWidth, window.innerWidth - 32)}px`;
  input.style.height = '0px';
  input.style.height = `${Math.min(Math.max(72, input.scrollHeight + 2 || 72), Math.max(72, Math.min(300, window.innerHeight - 300)))}px`;
}

function documentViewState(doc, keepDraft = true){
  const large = doc.source?.indexed || needsIndex(doc.size, settings.largeFileThresholdMiB);
  const mode = doc.viewOverride || (doc.design ? 'tree' : settings.viewMode);
  const available = !doc.error && !large;
  const canUseIde = available && (!settings.limitIdeComplexity || !!ideModel(doc, 'ide', settings.largeFileThresholdMiB));
  const active = !large && ((keepDraft && typeof doc.ideDraft === 'string')
    || (mode === 'ide' && canUseIde)
    || (mode === 'auto' && available && !!ideModel(doc, 'auto', settings.largeFileThresholdMiB)));
  return {active, canUseIde, large};
}

function syncDocumentView(doc, {active, canUseIde, large} = documentViewState(doc), refreshBuffer = true){
  ideActive = active;
  const panel = document.getElementById('ideView');
  panel.hidden = !ideActive; viewport.hidden = ideActive;
  if(ideActive && refreshBuffer){
    const input = document.getElementById('ideInput');
    input.value = doc.ideDraft ?? (doc.text || '').replace(/\r\n/g,'\n');
    renderIdeBuffer(doc);
    setIdeZoom(doc.ideZoom || 100);
    if(doc.ideSelection) input.setSelectionRange?.(doc.ideSelection.start, doc.ideSelection.end, doc.ideSelection.direction);
    input.scrollTop = doc.ideScrollTop || 0;
    input.scrollLeft = doc.ideScrollLeft || 0;
    syncIdeScroll();
    updateIdeScope();
  }else if(!ideActive && refreshBuffer){ document.getElementById('ideLines').replaceChildren(); ideLocations = new Map(); document.getElementById('ideStatus').hidden = true; }
  const switcher = document.getElementById('switchViewBtn');
  switcher.textContent = ideActive ? t('树形视图') : t('IDE 视图');
  switcher.disabled = !ideActive && !canUseIde;
  switcher.title = switcher.disabled ? (large ? t('大文件仅支持树形视图') : t('当前文档无法切换到 IDE 视图'))
    : msg`切换当前文件的查看方式（${shortcutText('switchView')}）`;
  for(const id of ['expandAllBtn','collapseAllBtn','resetViewBtn','recordTemplateBtn','editorBtn']) document.getElementById(id).hidden = ideActive;
  document.getElementById('editModeBtn').hidden = ideActive || !!doc.design;
  document.querySelector('.statusbar .help').textContent = ideActive ? msg`直接编辑 · ${primaryModifier} + ＋ / − 缩放 · ${primaryModifier} + 0 重置 · ${shortcutText('format')} 格式化` : msg`空白处拖动 · 滚轮平移 · ${primaryModifier} + 滚轮缩放 · 右键节点展开/收起子树`;
  document.getElementById('formatIdeBtn').disabled = !ideActive;
  searchScopeBtn.disabled = ideActive;
  if(ideActive) setEditMode(false);
  syncDesignControls();
  syncDocumentMenu();
}

function confirmDiscardEdits(){
  if(discardResolver) return Promise.resolve(false);
  document.getElementById('discardEditDialog').showModal();
  return new Promise(resolve => { discardResolver = resolve; });
}
function finishDiscardEdits(ok){
  document.getElementById('discardEditDialog').close();
  const resolve = discardResolver; discardResolver = null; resolve?.(ok);
}
function syncEditing(){
  const doc = activeDoc();
  if(!doc || doc.error || doc.source?.indexed || doc.design) editMode = false;
  viewer.classList.toggle('editing', editMode);
  document.getElementById('editModeBtn').setAttribute('aria-pressed', String(editMode));
  document.getElementById('editModeBtn').textContent = editMode ? t('退出编辑') : t('编辑模式');
  document.getElementById('editModeBtn').disabled = !doc || !!doc.error || !!doc.source?.indexed || !!doc.design;
  document.getElementById('undoEditBtn').disabled = !doc?.editHistory?.length;
  document.getElementById('redoEditBtn').disabled = !doc?.redoHistory?.length;
  document.getElementById('saveBtn').disabled = !doc?.dirty || !!doc?.saving;
  document.getElementById('saveCopyBtn').disabled = !doc?.dirty || !!doc?.saving;
  syncDesignControls();
  syncDocumentMenu();
}
function setEditMode(on, notify = false){
  const previous = editMode;
  editMode = !!on;
  syncEditing();
  if(!notify) return;
  if(previous !== editMode) showToast(editMode ? t('已进入编辑模式') : t('已返回阅读模式'));
  else if(on && !editMode){
    showToast(activeDoc()?.source?.indexed ? t('索引大文件暂只读') : t('当前文档无法进入编辑模式'));
  }
}

function normalizeDesignLimit(value){
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(32, Math.max(1, Math.trunc(number))) : 8;
}

function designLimitBytes(){
  return settings.designLimitMiB * 1024 ** 2;
}

function designLimitMessage(){
  return msg`设计模式仅支持小于 ${settings.designLimitMiB} MB 的 JSON 文档`;
}

function canDesign(doc){
  return !!doc && doc.kind === 'json' && !doc.error && !doc.source?.indexed &&
    (doc.editedSize ?? doc.size) < designLimitBytes();
}

function leaveDesign(doc){
  doc.design = false;
  doc.viewOverride = doc.designPreviousView;
  delete doc.designPreviousView;
}

function toggleDesignMode(){
  const doc = activeDoc();
  if(!doc || templateEditing || !leaveIde()) return;
  if(!doc.design && !canDesign(doc)){ showToast(designLimitMessage()); return; }
  snapshotDoc();
  if(doc.design) leaveDesign(doc);
  else {
    doc.designPreviousView = doc.viewOverride;
    doc.design = true;
    doc.viewOverride = 'tree';
    doc.ideDraft = undefined;
    editMode = false;
    persistDesignDraft(doc);
  }
  activateDoc(doc.id);
  saveSession();
  (ideActive ? document.getElementById('ideInput') : viewport).focus({preventScroll:true});
}

function designTarget(node = selectedCopyNode){
  const doc = activeDoc();
  if(!doc?.design || !canDesign(doc) || ideActive || templateEditing || !node || node.isConnected === false || node._source !== doc.source) return null;
  const path = node._path;
  const child = !node._jsonTreeReady && ['object','array'].includes(node._childrenType) ? node._childrenType : null;
  return { doc, path, child, sibling:path.length > 0, delete:path.length > 0, rename:path.length > 0 && !node._isArrayItem };
}

function syncDesignControls(){
  const doc = activeDoc(), target = designTarget();
  const visible = !!doc?.design && canDesign(doc) && !ideActive && !templateEditing;
  const button = document.getElementById('designModeBtn');
  button.textContent = doc?.design ? t('退出设计模式') : t('设计模式');
  button.setAttribute('aria-pressed', String(!!doc?.design));
  button.disabled = !doc || (!doc.design && !canDesign(doc));
  button.title = button.disabled && doc ? designLimitMessage() : button.textContent + '（' + shortcutText('designMode') + '）';
  const status = document.getElementById('editModeStatus');
  status.hidden = !visible && !editMode;
  status.textContent = visible ? t('设计模式') : t('编辑模式 · Esc 退出');
  document.getElementById('designDock').hidden = !visible || settings.showTopicDock !== true;
  viewer.classList.toggle('designing', visible);
  const card = target?.child ? selectedCopyNode._card : null;
  if(card){
    if(!topicAddButton){
      topicAddButton = document.createElement('button');
      topicAddButton.type = 'button';
      topicAddButton.className = 'topic-add';
      topicAddButton.textContent = '+';
      topicAddButton.addEventListener('click', () => {
        const target = designTarget();
        if(!target?.child) return;
        commitTopicAction(target, 'child');
      });
    }
    const label = target.child === 'array' ? t('添加数组元素') : t('新增子主题');
    topicAddButton.title = label;
    topicAddButton.setAttribute('aria-label', label);
    if(topicAddButton.parentElement !== card) card.appendChild(topicAddButton);
  }else topicAddButton?.remove();
  for(const [id, action] of [['designChild','child'], ['designSibling','sibling'], ['designRename','rename'], ['designDelete','delete']]){
    document.getElementById(id).disabled = !target?.[action];
  }
  document.getElementById('designChild').textContent = target?.child === 'array' ? t('添加元素') : t('子主题');
  document.getElementById('designSibling').textContent = typeof target?.path.at(-1) === 'number' ? t('插入元素') : t('同级主题');
  document.getElementById('designUndo').disabled = !doc?.editHistory?.length;
  document.getElementById('designSave').disabled = !doc?.dirty || !!doc.saving;
}

function beginTopicEdit(action, node){
  const target = designTarget(node);
  if(!target?.[action]) return false;
  if(action === 'delete' && target.child && Object.keys(valueAt(target.doc.parsed, target.path)).length){
    pendingTopicDeletion = target;
    closeMenu();
    document.getElementById('deleteTopicDialog').showModal();
    return true;
  }
  if(action === 'delete' || (action === 'child' && target.child === 'array')
    || (action === 'sibling' && typeof target.path.at(-1) === 'number')){
    commitTopicAction(target, action);
    return true;
  }
  designTopic = { ...target, action };
  document.getElementById('designTopicTitle').textContent = {
    child:t('添加子主题'), sibling:t('添加同级主题'), rename:t('重命名主题')
  }[action];
  const input = document.getElementById('designTopicName');
  input.value = action === 'rename' ? target.path.at(-1) : '';
  document.getElementById('designTopicError').textContent = '';
  closeMenu();
  document.getElementById('designTopicDialog').showModal();
  input.focus(); input.select();
  return true;
}

function commitTopicAction(target, action){
  try{ commitTopicEdit(target, action); }
  catch(error){ showToast(error.message); }
}

function commitTopicEdit({doc, path}, action, name){
  if(doc !== activeDoc()) throw new Error(t('当前文档已切换'));
  const parent = action === 'child' ? path : path.slice(0, -1);
  const key = path.at(-1), deleting = action === 'delete';
  if(action === 'rename' && name === key){
    document.getElementById('designTopicDialog').close();
    viewport.focus({preventScroll:true});
    return;
  }
  const container = valueAt(doc.parsed, parent);
  let next, selection, remapOpenPath;
  if(Array.isArray(container)){
    const index = action === 'child' ? container.length : deleting ? key : key + 1;
    const items = container.slice();
    if(deleting) items.splice(index, 1);
    else items.splice(index, 0, null);
    next = replaceValue(doc.parsed, parent, items);
    selection = deleting ? parent : parent.concat(index);
    const prefix = encodePath(parent);
    remapOpenPath = item => {
      if(!item.startsWith(prefix)) return [item];
      const match = /^\[(\d+)\]/.exec(item.slice(prefix.length));
      if(!match || Number(match[1]) < index) return [item];
      if(deleting && Number(match[1]) === index) return [];
      const moved = Number(match[1]) + (deleting ? -1 : 1);
      return [prefix + '[' + moved + ']' + item.slice(prefix.length + match[0].length)];
    };
  }else{
    if(name === undefined && !deleting){
      name = t('子主题');
      for(let i = 2; Object.hasOwn(container, name); i++) name = t('子主题 ') + i;
    }
    next = editObjectTopic(doc.parsed, parent, deleting || action === 'rename' ? key : null, deleting ? null : name);
    selection = deleting ? parent : parent.concat(name);
    const before = encodePath(path), after = encodePath(selection);
    remapOpenPath = item => {
      if((!deleting && action !== 'rename') || (item !== before && !isPathPrefix(before, item, false))) return [item];
      return deleting ? [] : [after + item.slice(before.length)];
    };
  }
  const text = serializeDocument({kind:'json', parsed:next});
  const size = new Blob([text]).size;
  if(size >= designLimitBytes()) throw new Error(designLimitMessage());
  snapshotDoc();
  rememberEdit(doc, null, true);
  doc.editHistory.at(-1).topicSelection = path;
  const open = (doc.openPaths || []).flatMap(remapOpenPath);
  for(let i = 0; i <= parent.length; i++) open.push(encodePath(parent.slice(0, i)));
  doc.openPaths = [...new Set(open)];
  const untyped = new Set([...doc.untypedTopics || []].flatMap(remapOpenPath));
  if(action === 'child' || action === 'sibling'){
    untyped.delete(encodePath(parent));
    untyped.add(encodePath(selection));
  }
  doc.untypedTopics = untyped;
  doc.parsed = next;
  setEditedText(doc, text, size);
  doc.dirty = true;
  doc.searchQuery = '';
  persistDesignDraft(doc);
  activateDoc(doc.id, selection);
  viewport.focus({preventScroll:true});
}

async function selectDesignPath(path, generation){
  let node = tree.firstElementChild;
  for(const key of path){
    const loaded = await node?._ensureChildren?.(key);
    if(generation !== expansionGeneration || !loaded) return;
    node.classList.add('open');
    const children = directChildrenContainer(node)?.children;
    node = [...(children || [])].find(child => child._pageKey === key);
    if(!node) return;
  }
  if(!node) return;
  selectedSearchPath = path;
  selectCopyNode(node);
  revealCanvasNode(node);
}

function revealCanvasNode(node){
  const row = node.firstElementChild;
  const rect = row.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
  if(rect.left < bounds.left || rect.top < bounds.top || rect.right > bounds.right || rect.bottom > bounds.bottom){
    centerNode(node, row);
  }
}

function canEditNode(node){
  const doc = activeDoc();
  return !!doc && !doc.error && !doc.source?.indexed && !!node && node.isConnected !== false && node._source === doc.source;
}
function beginNodeEdit(node){
  if(!canEditNode(node)) return;
  const doc = activeDoc(), value = valueAt(doc.data, node._sourcePath);
  const untyped = doc.design && doc.untypedTopics?.has(encodePath(node._sourcePath));
  const type = untyped ? '' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  editingNode = { doc, path: [...node._sourcePath], type };
  document.getElementById('valueEditPath').textContent = encodePath(node._path);
  document.getElementById('valueEditType').value = type;
  document.getElementById('valueEditText').value = untyped ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  document.getElementById('valueEditError').textContent = '';
  closeMenu(); document.getElementById('valueEditDialog').showModal();
  document.getElementById('valueEditHint').textContent = doc.kind === 'jsonl'
    ? t('字符串直接输入，其他类型填写 JSON。另存为仅导出有效记录，不保留注释和坏行。')
    : t('字符串直接输入，其他类型填写 JSON。修改先保留在工作副本中，可保存到原文件或另存为副本。');
  resizeNodeEditor();
  document.getElementById('valueEditText').focus();
}
function applyNodeEdit(){
  const state = editingNode;
  if(!state || state.doc !== activeDoc()) throw new Error(t('当前文件已切换，请重新选择节点'));
  const doc = state.doc;
  const type = document.getElementById('valueEditType').value;
  if(!type) throw new Error(t('请选择值类型'));
  const value = parseEdit(document.getElementById('valueEditText').value, type);
  const wrapped = doc.kind === 'jsonl' && doc.records.length > 1 && settings.jsonlWrapArray !== false;
  if(doc.kind === 'jsonl' && wrapped && !state.path.length && !Array.isArray(value)) throw new Error(t('JSONL 记录列表必须保留为数组'));
  if(doc.kind === 'jsonl' && wrapped && !state.path.length && !value.length) throw new Error(t('JSONL 至少需要一条记录'));
  const next = replaceValue(doc.data, state.path, value);
  const designText = doc.design ? serializeDocument({kind:'json', parsed:next}) : null;
  const designSize = designText === null ? undefined : new Blob([designText]).size;
  if(designSize !== undefined && designSize >= designLimitBytes()) throw new Error(designLimitMessage());
  snapshotDoc();
  rememberEdit(doc, null, true);
  if(doc.design){
    doc.editHistory.at(-1).topicSelection = state.path;
    const changed = encodePath(state.path);
    if(doc.untypedTopics){
      doc.untypedTopics = new Set([...doc.untypedTopics].filter(path => path !== changed && !isPathPrefix(changed, path, false)));
    }
    doc.openPaths = (doc.openPaths || []).filter(path => !isPathPrefix(changed, path, false));
    if(value === null || typeof value !== 'object') doc.openPaths = doc.openPaths.filter(path => path !== changed);
  }
  if(doc.kind !== 'jsonl') doc.parsed = next;
  else if(wrapped) doc.records = next;
  else { doc.records = doc.records.slice(); doc.records[0] = next; }
  doc.dirty = true;
  setEditedText(doc, designText ?? serializeDocument(doc), designSize);
  // Export omits skipped JSONL lines; the loaded document retains its diagnostics.
  doc.searchQuery = '';
  editingNode = null; document.getElementById('valueEditDialog').close();
  persistDesignDraft(doc);
  activateDoc(doc.id, doc.design ? state.path : null);
  if(doc.design) viewport.focus({preventScroll:true});
}


const landing = document.getElementById('landing');
const viewer = document.getElementById('viewer');
const fileInput = document.getElementById('fileInput');
const chooseBtn = document.getElementById('chooseBtn');
const dropZone = document.getElementById('dropZone');

const fileName = document.getElementById('fileName');
const fileSub = document.getElementById('fileSub');
const openAnotherBtn = document.getElementById('openAnotherBtn');
const expandAllBtn = document.getElementById('expandAllBtn');
const collapseAllBtn = document.getElementById('collapseAllBtn');
const nextMatchBtn = document.getElementById('nextMatchBtn');
const prevMatchBtn = document.getElementById('prevMatchBtn');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const searchError = document.getElementById('searchError');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const quickSearchInput = document.getElementById('quickSearchInput');
const quickSearchCount = document.getElementById('quickSearchCount');
const quickNextMatchBtn = document.getElementById('quickNextMatchBtn');
const findPanel = document.getElementById('findPanel');
const findDragHandle = document.getElementById('findDragHandle');
const pinFindBtn = document.getElementById('pinFindBtn');
const findPlacementKey = 'json-atlas_find-window_v2';
const findPlacement = { edge: 'right', inset: 16, top: 0, pinned: false };
let legacyFindPlacement = null;
try {
  const saved = JSON.parse(localStorage.getItem(findPlacementKey));
  if(saved && ['left', 'right'].includes(saved.edge) && Number.isFinite(saved.inset) && Number.isFinite(saved.top)){
    Object.assign(findPlacement, { edge: saved.edge, inset: saved.inset, top: saved.top, pinned: saved.pinned === true });
  } else {
    const legacy = JSON.parse(localStorage.getItem('json-atlas_find-window_v1'));
    if(legacy && Number.isFinite(legacy.x) && Number.isFinite(legacy.y)){
      legacyFindPlacement = legacy;
      findPlacement.pinned = legacy.pinned === true;
    }
  }
} catch { /* Ignore unavailable storage or obsolete placement. */ }
let findDrag = null;
const searchOptions = { caseSensitive: false, wholeWord: false, regex: false, scopePath: null };
const searchScopeBtn = document.getElementById('searchScopeBtn');
let selectedSearchPath = null;
let selectedCopyNode = null;
function copyNodeMenuState(){
  return {id:'copy-node',text:t('复制选中节点内容'),shortcut:shortcutText('copyNode'),
    enabled:!templateEditing && !ideActive && !!selectedCopyNode?.isConnected};
}
function selectCopyNode(node){
  const changed = selectedCopyNode !== node;
  selectedCopyNode?.classList.remove('selected-node');
  selectedCopyNode = node;
  node?.classList.add('selected-node');
  syncDesignControls();
  if(changed && desktop && macPlatform) updateDocumentMenu([copyNodeMenuState()]);
}
let lastSearchSignature = null;

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const tree = document.getElementById('tree');
const viewportWindow = new ViewportWindow(viewport);
const pathText = document.getElementById('pathText');

const fileRail = document.getElementById('fileRail');
const loadingStatus = document.getElementById('loadingStatus');
const loadingLabel = document.getElementById('loadingLabel');
const loadingProgress = document.getElementById('loadingProgress');
const docError = document.getElementById('docError');

const zoomOutBtn = document.getElementById('zoomOutBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomLabel = document.getElementById('zoomLabel');
const resetViewBtn = document.getElementById('resetViewBtn');

let parsedData = null;
let matches = [];
let currentMatchIndex = -1;

/* 根节点显示名（JSONL 会显示「N 条记录」这类标签，JSON 保持 root） */
let currentRootLabel = 'root';
/* 主视图最近的平移 / 缩放，由画布回调写入，供刷新恢复阅读位置 */
let lastViewState = null;     /* {x, y, scale} */

const MIN_SCALE = .45;
const MAX_SCALE = 2.2;

/* ---------- JSONL / 解析工具 ---------- */
function jsonlModeHints(){
  const bits = [];
  bits.push(settings.jsonlWrapArray !== false ? t('数组根') : t('首条为根'));
  bits.push(settings.strictJsonl ? t('严格模式（坏行即拒绝）') : t('坏行跳过'));
  return bits.join(' · ');
}

/* ---------- 多文件：文档（条纹）模型 ----------
   每份打开的文件是一个文档；左侧条纹栏里一根条纹对应一个文档。
   全局镜像（parsedData / currentRootLabel）始终等于「当前激活文档」的值：
   切换时先把旧文档的阅读状态快照回去，再把新文档铺开。 */
let docs = [];
let activeDocId = null;
let docSeq = 0;
let memoryReleaseTimer;

function activeDoc(){
  return docs.find(d => d.id === activeDocId) || null;
}

/* 本地存储 / 会话里用「文件名 + 体积」定位文档，不用易变的自增 id */
function docKey(doc){ return doc.identity || doc.path || `${doc.name}::${doc.size}`; }

function makeDoc(name, size, text, kind){
  return {
    id: 'doc' + (++docSeq),
    name, size, text, kind,
    inactiveSince: Date.now(),
    parsed: undefined,   /* kind === 'json' 时的解析结果 */
    records: null,       /* kind === 'jsonl' 时的记录数组 */
    bad: [],             /* JSONL 里不合规的行（解析失败行 + 注释行） */
    totalLines: 0,
    rootLabel: 'root',
    data: undefined,     /* 按当前 settings 折算出的、真正渲染的根数据 */
    sub: '',             /* 条纹信息 / 顶部副标题用的一行摘要 */
    error: null,         /* 非空表示当前设置下无法渲染 */
    view: null,          /* {x, y, scale}，切走时快照 */
    openPaths: null,     /* 展开的节点精确路径，保留数组真实下标 */
    searchQuery: ''      /* 这份文件上次的搜索词 */
  };
}

/* 文本 → 文档。解析失败不抛错，而是记进 doc.error：
   条纹栏里仍能看到这个文件，也便于关掉严格模式后再试一次 */
function buildDoc(text, name, size){
  const result = parseDocument(text, name);
  return Object.assign(makeDoc(name, size, text, result.kind), result);
}
const badLinesPreview = list => list.slice(0, 10)
  .map(b => msg`  第 ${b.line} 行：${b.message}\n    ${(b.text || '').slice(0, 160)}`)
  .join('\n') + (list.length > 10 ? msg`\n  …另有 ${list.length - 10} 行` : '');

/* 按当前 settings 把文档折算成可渲染状态：{data, rootLabel, sub, warn} 或 {error} */
function resolveDoc(doc){
  if(doc.source?.indexed){
    const info = doc.source.info;
    if(settings.strictJsonl && info.kind === 'jsonl' && info.badCount + info.commentCount > 0){
      return { error: msg`严格模式下拒绝加载：${info.badCount + info.commentCount} 行不合规（含注释行）。可在设置中关闭严格模式后继续阅读。` };
    }
    const wrap = doc.source.wrap && info.records > 1;
    return { data: doc.source, rootLabel: info.kind === 'jsonl'
      ? (wrap ? msg`${info.records} 条记录` : info.records === 1 ? t('单条记录') : t('首条记录')) : 'root',
      sub: [t('索引模式 · 按页读取'), info.kind === 'jsonl' ? msg`${info.records} 条记录` : '',
        info.badCount ? msg`${info.badCount} 行已跳过` : ''].filter(Boolean).join(' · ') };
  }
  if(doc.kind !== 'jsonl'){
    if(doc.error) return { error: doc.error };
    return { data: doc.parsed, rootLabel: 'root', sub: '' };
  }

  const parseBad = doc.bad.filter(b => !b.comment);
  const commentBad = doc.bad.filter(b => b.comment);
  const strict = !!settings.strictJsonl;

  /* 严格模式：任一行违规即拒绝整文件，不做部分渲染 */
  if(strict && doc.bad.length){
    const why = [
      parseBad.length ? msg`${parseBad.length} 行 JSON 解析失败` : null,
      commentBad.length ? msg`${commentBad.length} 行为注释行（JSONL 规范不支持）` : null
    ].filter(Boolean).join(getLanguage() === 'en' ? ', ' : '，');
    return { error:
      msg`严格模式下拒绝加载：${why}（共 ${doc.totalLines} 行）。\n` +
      msg`可在「设置 → 文件与恢复 → JSONL」关闭严格模式以跳过这些行。\n\n` + badLinesPreview(doc.bad) };
  }

  if(!doc.records.length) return { error: doc.error || t('文件内没有可解析的记录') };

  /* 非严格模式：注释行静默跳过，只有解析失败行会提示（与旧行为一致） */
  const visibleBad = parseBad;
  const wrap = doc.records.length > 1 && settings.jsonlWrapArray !== false;

  return {
    data: wrap ? doc.records : doc.records[0],
    rootLabel: wrap
      ? msg`${doc.records.length} 条记录`
      : (doc.records.length === 1 ? t('单条记录') : t('首条记录')),
    sub: [
      msg`JSONL · ${doc.records.length} 条记录`,
      visibleBad.length ? msg`${visibleBad.length} 行已跳过` : null
    ].filter(Boolean).join(' · '),
    warn: visibleBad.length
      ? msg`以下行不符合 JSONL，已跳过（其余 ${doc.records.length} 条正常显示）：\n` + badLinesPreview(visibleBad)
      : null
  };
}

/* 切走前把当前文档的阅读状态（展开层级 / 视图 / 搜索词）快照回文档对象。
   文档当前处于错误态时树没有渲染，保留上一次的快照不动 */
function snapshotDoc(){
  const doc = activeDoc();
  if(!doc || doc.error) return;
  if(ideActive){
    const input = document.getElementById('ideInput');
    doc.ideScrollTop = input.scrollTop;
    doc.ideScrollLeft = input.scrollLeft;
    if(Number.isInteger(input.selectionStart) && Number.isInteger(input.selectionEnd)){
      doc.ideSelection = { start:input.selectionStart, end:input.selectionEnd, direction:input.selectionDirection };
    }
    doc.searchQuery = searchInput.value || '';
    return;
  }

  if(restoringExpansion !== expansionGeneration){
    const open = [...tree.querySelectorAll('.tree-node.open')];
    doc.openPaths = open.map(node => node.dataset.path);
    doc.pageOffsets = Object.fromEntries(open.filter(node => node._pageStart > 0)
      .map(node => [node.dataset.path, node._pageStart]));
    if(lastViewState) doc.view = { ...lastViewState };
  }
  doc.searchQuery = searchInput.value || '';
  doc.data = parsedData;
  doc.rootLabel = currentRootLabel;
}

function normalizeIdleRelease(value){
  return [1,5,15,30,60].includes(Number(value)) ? Number(value) : 0;
}

function normalizeResidentLimit(value){
  return [1,2,4,8,16].includes(Number(value)) ? Number(value) : 0;
}

function canReleaseDocument(doc){
  return doc.id !== activeDocId && !doc.unloaded && !doc.dirty && !doc.temporary &&
    !doc.saving && !doc.indexRebuild && !doc.editHistory?.length && !doc.redoHistory?.length &&
    (!selectedLoad?.key || selectedLoad.key !== docKey(doc)) &&
    !!((desktop && doc.path) || typeof doc.text === 'string');
}

function scheduleMemoryRelease(){
  clearTimeout(memoryReleaseTimer);
  if(!settings.idleReleaseMinutes) return;
  const idleTime = settings.idleReleaseMinutes * 60000;
  let next = Infinity;
  for(const doc of docs){
    if(canReleaseDocument(doc)) next = Math.min(next, doc.inactiveSince + idleTime);
  }
  if(Number.isFinite(next)) memoryReleaseTimer = setTimeout(releaseIdleDocuments, Math.max(0, next - Date.now()));
}

function releaseDocument(doc){
  doc.source?.dispose();
  Object.assign(doc, {
    unloaded:'idle', source:undefined, parsed:undefined, records:null, bad:[], data:undefined,
    ideDraft:undefined, ideProjection:undefined, ideRows:undefined, ideScopePairs:undefined
  });
  if(desktop && doc.path){
    doc.text = undefined;
    doc.savedText = undefined;
    doc.diskText = undefined;
  }
}

function enforceResidentLimit(){
  if(!settings.residentFileLimit) return 0;
  const excess = docs.filter(doc => !doc.unloaded).length - settings.residentFileLimit;
  if(excess <= 0) return 0;
  const candidates = docs.filter(canReleaseDocument)
    .sort((first, second) => first.inactiveSince - second.inactiveSince)
    .slice(0, excess);
  candidates.forEach(releaseDocument);
  return candidates.length;
}

function releaseIdleDocuments(){
  if(!settings.idleReleaseMinutes) return;
  const cutoff = Date.now() - settings.idleReleaseMinutes * 60000;
  const candidates = docs.filter(doc => doc.inactiveSince <= cutoff && canReleaseDocument(doc));
  candidates.forEach(releaseDocument);
  if(candidates.length) renderRail();
  scheduleMemoryRelease();
}

/* 激活某个文档：折算解析结果 → 铺到全局镜像 → 渲染 → 恢复它自己的阅读状态 */
function activateDoc(id, designPath = null){
  const doc = docs.find(d => d.id === id);
  if(!doc) return;
  if(doc.unloaded){
    if(desktop && doc.path) return queueFiles([{path:doc.path, resumeId:doc.id}]);
    Object.assign(doc, parseDocument(doc.text, doc.name));
    delete doc.unloaded;
  }
  selectedLoad = null;
  loadingStatus.hidden = true;
  if(activeDoc()) activeDoc().ideEditGroup = null;

  vimPrefix = null;
  closeMenu();
  const previousDoc = activeDoc();
  if(previousDoc && previousDoc !== doc){
    snapshotDoc();
    previousDoc.inactiveSince = Date.now();
  }
  const changedDoc = activeDocId !== id;
  activeDocId = id;
  if(changedDoc && canvasRulesDialog.open && canvasRulesDoc !== doc) canvasRulesDialog.close();
  if(changedDoc && settingsMask.classList.contains('open')) updateTemplateStatus();
  if(doc.design && !canDesign(doc)) leaveDesign(doc);
  expansionGeneration++;
  viewportWindow.clear();
  discardPagedTree(tree);
  closeEditor();
  closeModal();
  editingNode = null; document.getElementById('valueEditDialog').close();
  document.getElementById('designTopicDialog').close();
  document.getElementById('deleteTopicDialog').close();
  document.getElementById('saveConflictDialog').close();
  updateWindowTitle(doc.name);

  const r = resolveDoc(doc);
  doc.error = r.error || null;
  doc.sub = r.sub || '';
  if(r.data !== undefined){ doc.data = r.data; doc.rootLabel = r.rootLabel; }

  /* 当前仍保留内存解析结果；树、搜索及全文读取经 doc.source 访问。 */
  parsedData = doc.data;
  currentRootLabel = doc.rootLabel;

  landing.style.display = 'none';
  viewer.style.display = 'flex';

  updateDocHeader(doc);
  syncEditing();
  enforceResidentLimit();
  scheduleMemoryRelease();
  renderRail();
  saveReopenCopy();

  /* 搜索框 / 上一次的匹配列表一律重置：命中的节点属于上一份文件 */
  resetSearchState();

  if(doc.error){
    syncDocumentView(doc);
    /* 清空画布，否则上一份文件的树会留在半透明错误面板后面 */
    tree.innerHTML = '';
    tree.classList.remove('virtualized');
    renderDocError(doc);
    return;
  }
  hideDocError();

  /* 重建树：初始全收起，稍后按这份文件上次的展开状态恢复 */
  renderTree(parsedData, currentRootLabel);
  syncDocumentView(doc);
  if(ideActive){
    if(doc.searchQuery){ searchInput.value = doc.searchQuery; searchTree(doc.searchQuery); }
    scheduleSessionSave();
    return;
  }
  if(doc.design && canDesign(doc)){
    selectedSearchPath = [];
    selectCopyNode(tree.firstElementChild);
  }

  const activation = expansionGeneration;
  restoringExpansion = activation;
  requestAnimationFrame(async () => {
    if(activation !== expansionGeneration) return;
    if(activeDocId !== doc.id) return;
    if(Array.isArray(doc.openPaths)){
      try{
        await expandByPaths(doc.openPaths, { exact:true, pageOffsets:doc.pageOffsets });
      }finally{
        if(restoringExpansion === activation) restoringExpansion = null;
      }
      if(activeDocId !== doc.id || activation !== expansionGeneration) return;
      if(doc.view) applySessionView(doc.view); else resetView();
    }else{
      resetView();
      try{
        await applyOpenPolicy();
      }finally{
        if(restoringExpansion === activation) restoringExpansion = null;
      }
      if(activeDocId !== doc.id || activation !== expansionGeneration) return;
      if(doc.view) applySessionView(doc.view);
    }
    if(doc.searchQuery){
      searchInput.value = doc.searchQuery;
      quickSearchInput.value = doc.searchQuery;
      searchTree(doc.searchQuery);
    }
    if(doc.design && designPath?.length) await selectDesignPath(designPath, activation);
  });

  scheduleSessionSave();
}

/* 关闭某个文档：它的会话随之丢弃；关掉当前文件则自动切到相邻的一份 */
function closeDoc(id){
  const idx = docs.findIndex(d => d.id === id);
  if(idx < 0) return;

  const wasActive = id === activeDocId;
  const closing = docs[idx];
  if(closing.dirty){
    confirmDiscardEdits().then(ok => { if(ok){ closing.dirty = false; closeDoc(id); } });
    return;
  }
  persistDesignDraft(closing);
  const loading = fileLoads.find(job => job.file.resumeId === id);
  if(loading) cancelFileLoad(loading);
  closing.indexRebuild?.abort();
  closing.source?.dispose({ forget:true });

  if(wasActive) snapshotDoc();
  docs.splice(idx, 1);

  if(!docs.length){
    withdrawView();
  }else if(wasActive || (!activeDoc() && !selectedLoad && loading)){
    const next = docs[Math.min(idx, docs.length - 1)];
    if(next.unloaded && desktop && next.path) withdrawView();
    activateDoc(next.id);
  }else{
    renderRail();
  }

  scheduleMemoryRelease();
  saveReopenCopy();
  saveSession();
  syncEditing();
  showToast(msg`已关闭 ${closing.name}`);
}

function updateDocHeader(doc){
  fileName.textContent = doc.name + (doc.dirty ? t(' • 未保存') : '');
  fileName.title = doc.path || (doc.temporary ? t('临时文件 · 尚未选择保存位置') : doc.name);

  const kindTag = doc.kind === 'jsonl' ? ' · JSONL' : '';
  const rootType = doc.source?.indexed ? doc.source.getRoot().type : null;
  const typeName = doc.error ? t('无法预览') : rootType ? ({array:'Array',object:'Object'}[rootType] || rootType) : getTypeName(doc.data);
  fileSub.textContent = `${formatBytes(doc.editedSize ?? doc.size)} · ${typeName}${kindTag}`;
  fileSub.title = doc.kind === 'jsonl' ? [doc.sub, jsonlModeHints()].filter(Boolean).join(' · ') : doc.sub;
}

function resetSearchState(){
  focusGeneration++;
  clearTimeout(searchTimer);
  searchGeneration++;
  matches = [];
  currentMatchIndex = -1;
  searchInput.value = '';
  quickSearchInput.value = '';
  searchTruncated = false; searchCount.title = ''; quickSearchCount.title = '';
  setSearchCount('');
  nextMatchBtn.disabled = true;
  prevMatchBtn.disabled = true;
  lastSearchSignature = null;
  searchOptions.scopePath = null; selectedSearchPath = null; selectCopyNode(null);
  searchScopeBtn.setAttribute('aria-pressed', 'false');
  searchScopeBtn.title = t('仅在选中节点内查找：先点击一个节点');
  tree.querySelectorAll('.search-scope-node').forEach(n => n.classList.remove('search-scope-node'));
  setSearchError('');
  clearSearchHighlights();
  pathText.textContent = t('路径：$');
}

/* ---------- 左侧条纹栏 ---------- */
function fileProblem(doc){
  if(doc.unloaded) return {};
  const error = resolveDoc(doc).error;
  const info = doc.source?.indexed ? doc.source.info : null;
  const skipped = info ? (info.badCount || 0) + (info.commentCount || 0) : doc.bad?.length || 0;
  return { error, skipped };
}
/* 条纹信息里的一行摘要：类型 / 记录数 / 体积 */
function railMeta(doc, problem = fileProblem(doc)){
  if(doc.unloaded) return doc.unloaded === 'idle' ? t('内存已释放 · 点击重新载入') : t('待载入 · 点击打开');
  const bits = [doc.kind === 'jsonl' ? 'JSONL' : 'JSON'];
  if(doc.temporary) bits.unshift(t('临时文件'));
  if(doc.dirty) bits.push(t('未保存'));
  if(doc.kind === 'jsonl' && doc.records) bits.push(msg`${doc.records.length} 条记录`);
  if(problem.error) bits.push(t('无法预览'));
  else if(problem.skipped) bits.push(msg`已跳过 ${problem.skipped} 行`);
  bits.push(formatBytes(doc.editedSize ?? doc.size));
  return bits.join(' · ');
}

let railPreview = null, railList = null, railPreviewRange = '';
function setRailFileDetails(doc, tab, meta, text, error){
  meta.textContent = text;
  tab.title = `${doc.path || doc.name}\n${text}${error ? '\n' + error : ''}`;
  tab.setAttribute('aria-label', `${doc.name}，${text}`);
}

function updateRailFileDetails(doc){
  const slot = Array.from(railList?.children || []).find(item => item.dataset.id === doc.id);
  if(!slot || slot.classList.contains('loading')) return;
  const tab = slot.firstElementChild;
  const problem = fileProblem(doc);
  setRailFileDetails(doc, tab, tab.querySelectorAll('.file-tab-meta')[0], railMeta(doc, problem), problem.error);
}
function syncRailDialOverflow(){
  const overflows = fileRail.classList.contains('rail-dial') &&
    railList?.scrollHeight > railList?.clientHeight;
  fileRail.classList.toggle('rail-dial-overflow', overflows);
}

function createRailScrollControl(direction){
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'rail-scroll rail-scroll-' + (direction < 0 ? 'up' : 'down');
  button.setAttribute('aria-label', direction < 0 ? t('向上滚动文件栏') : t('向下滚动文件栏'));

  let drag = null;
  let dragged = false;
  button.addEventListener('pointerdown', event => {
    if(!event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, y: event.clientY, top: railList.scrollTop };
    dragged = false;
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener('pointermove', event => {
    if(drag?.id !== event.pointerId) return;
    const delta = drag.y - event.clientY;
    if(!dragged && Math.abs(delta) < 4) return;
    dragged = true;
    railList.scrollTop = drag.top + delta;
  });
  button.addEventListener('lostpointercapture', () => { drag = null; });
  button.addEventListener('click', event => {
    if(!dragged || event.detail === 0) railList.scrollTop += direction * railList.clientHeight / 2;
    dragged = false;
  });
  button.addEventListener('wheel', event => {
    if(event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 12 : event.deltaMode === 2 ? railList.clientHeight : 1;
    railList.scrollTop += event.deltaY * unit;
  }, { passive:false });
  return button;
}

const railScrollUp = createRailScrollControl(-1);
const railScrollDown = createRailScrollControl(1);

function syncRailPreview(){
  syncRailDialOverflow();
  if(!railPreview || !railList || !railPreview.clientHeight) return;
  const style = getComputedStyle(fileRail);
  const height = parseFloat(style.getPropertyValue('--rail-preview-row-height'));
  const gap = parseFloat(style.getPropertyValue('--rail-row-gap'));
  const stride = height + gap;
  const total = railList.children.length - 2;
  const count = Math.min(total, Math.floor((railPreview.clientHeight + gap) / stride));
  const active = Math.max(0, Array.from(railList.children).findIndex(slot =>
    slot.classList.contains(selectedLoad ? 'requested' : 'active')));
  const start = Math.min(Math.max(0, active - Math.floor(count / 2)), total - count);
  const rowsHeight = Math.max(0, total * stride - gap);
  // The separator occupies 1px plus 8px of margins in the compact rail.
  const showAdd = count === total && rowsHeight + height + 9 + gap * (total ? 2 : 1) <= railPreview.clientHeight;
  const range = `${start}:${count}:${showAdd}`;
  if(range === railPreviewRange) return;
  railPreviewRange = range;
  railPreview.replaceChildren();
  const previewSlot = slot => {
    const item = document.createElement('div');
    item.className = slot.className.replace('file-slot', 'rail-preview-slot');
    const tab = document.createElement('div');
    tab.className = 'file-tab';
    item.appendChild(tab);
    railPreview.appendChild(item);
  };
  for(let index = start; index < start + count; index++) previewSlot(railList.children[index]);
  if(showAdd){
    const sep = document.createElement('div');
    sep.className = 'rail-sep';
    railPreview.appendChild(sep);
    previewSlot(railList.children[total + 1]);
  }
}
if(typeof ResizeObserver === 'function') new ResizeObserver(syncRailPreview).observe(fileRail);
else window.addEventListener('resize', syncRailPreview);

function renderRail(){
  pendingRailRefresh = false;
  refreshMemoryStats();
  const previousScroll = railList?.scrollTop || 0;
  applyRailStyle();
  fileRail.innerHTML = '';

  /* 展开时才浮出的毛玻璃底：与文件列表分开，折叠时侧栏完全透明 */
  const glass = document.createElement('div');
  glass.className = 'rail-glass';
  fileRail.appendChild(glass);

  const list = document.createElement('div');
  list.className = 'rail-list';
  list.setAttribute('tabindex', '0');
  list.setAttribute('aria-label', t('已打开的文件列表，可滚动'));

  const openKeys = new Set(docs.map(docKey));
  const jobsByPath = new Map(fileLoads.filter(job => job.key).map(job => [job.key, job]));
  const pending = fileLoads.filter(job => !job.key || !openKeys.has(job.key));
  const entries = [...docs, ...pending].sort((a,b) => (a.loadOrder || 0) - (b.loadOrder || 0));
  entries.forEach(doc => {
    const job = doc.file ? doc : jobsByPath.get(docKey(doc));
    const loading = job || doc.indexRebuild;
    const problem = loading ? {} : fileProblem(doc);
    const metaText = loading ? t('正在加载…') : railMeta(doc, problem);
    const slot = document.createElement('div');
    slot.className = 'file-slot'
      + (doc.id === activeDocId ? ' active' : '')
      + (loading ? ' loading' : '')
      + (!loading && doc.unloaded === 'idle' ? ' released' : '')
      + (job && job === selectedLoad ? ' requested' : '')
      + (problem.error ? ' error' : problem.skipped ? ' warning' : '');
    slot.dataset.id = doc.id;

    const tab = document.createElement('div');
    tab.className = 'file-tab';
    if(loading) tab.setAttribute('aria-busy', 'true');
    tab.setAttribute('aria-current', doc.id === activeDocId ? 'true' : 'false');

    const dot = document.createElement('span');
    dot.className = 'file-dot';

    const info = document.createElement('div');
    info.className = 'file-info';
    const nm = document.createElement('div');
    nm.className = 'file-tab-name';
    nm.textContent = doc.name;
    const meta = document.createElement('div');
    meta.className = 'file-tab-meta';
    setRailFileDetails(doc, tab, meta, metaText, problem.error);
    info.append(nm, meta);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'file-close';
    close.textContent = '✕';
    close.title = t('关闭这份文件');
    close.addEventListener('click', e => {
      e.stopPropagation();
      if(job) cancelFileLoad(job);
      if(!doc.file) closeDoc(doc.id);
    });

    tab.append(dot, info, close);
    const openFile = () => {
      if(job) prioritizeFileLoad(job);
      else if(doc.id !== activeDocId || selectedLoad) activateDoc(doc.id);
    };
    tab.addEventListener('click', openFile);
    slot.addEventListener('click', event => {
      if(event.target === slot) openFile();
    });

    slot.appendChild(tab);
    list.appendChild(slot);
  });

  const sep = document.createElement('div');
  sep.className = 'rail-sep';
  list.appendChild(sep);

  /* 末尾的「打开文件」色条：折叠时虚线轮廓，展开后是一行入口 */
  const addInfo = document.createElement('div');
  addInfo.className = 'file-info';
  const addName = document.createElement('div');
  addName.className = 'file-tab-name';
  addName.textContent = t('打开文件…');
  const addMeta = document.createElement('div');
  addMeta.className = 'file-tab-meta';
  addMeta.textContent = t('可多选，或把文件拖进来');
  addInfo.append(addName, addMeta);

  const plus = document.createElement('span');
  plus.className = 'file-plus';
  plus.textContent = '＋';

  const addTab = document.createElement('div');
  addTab.className = 'file-tab';
  addTab.append(plus, addInfo);
  addTab.addEventListener('click', () => chooseFiles());

  const add = document.createElement('div');
  add.className = 'file-slot rail-add';
  add.title = t('打开更多文件（可多选，也可把文件拖进来）');
  add.appendChild(addTab);
  list.appendChild(add);

  railList = list;
  railPreview = document.createElement('div');
  railPreview.className = 'rail-preview';
  railPreview.setAttribute('aria-hidden', 'true');
  railPreviewRange = '';
  fileRail.append(railPreview, railScrollUp, list, railScrollDown);
  list.scrollTop = previousScroll;
  syncPendingRail();
  syncRailPreview();
}

function scheduleRailRefresh(){
  if(pendingRailRefresh) return;
  pendingRailRefresh = true;
  requestAnimationFrame(() => {
    if(pendingRailRefresh) renderRail();
  });
}

function syncPendingRail(){
  const pendingOnly = !activeDoc() && (docs.length > 0 || fileLoads.length > 0);
  viewer.classList.toggle('pending-files', pendingOnly);
  if(activeDoc()) return;
  viewer.style.display = pendingOnly ? 'flex' : 'none';
  landing.style.display = pendingOnly ? 'none' : 'grid';
}

/* ---------- 文档错误面板 ---------- */
function renderDocError(doc){
  nodeBudget.reset(); updateNodeBudgetNotice();
  docError.innerHTML = '';

  const card = document.createElement('div');
  card.className = 'doc-error-card';

  const title = document.createElement('div');
  title.className = 'doc-error-title';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = t('这份文件当前无法预览');
  title.append(dot, label);

  const file = document.createElement('div');
  file.className = 'doc-error-file';
  file.textContent = doc.name;
  file.title = doc.name;

  const body = document.createElement('div');
  body.className = 'doc-error-body';
  body.textContent = doc.error;

  const actions = document.createElement('div');
  actions.className = 'doc-error-actions';
  let retryButton;

  /* 严格模式是唯一能让「被拒绝」的 JSONL 重新可读的设置，给一个就地开关 */
  const indexedInfo = doc.source?.info;
  const invalidLines = indexedInfo ? indexedInfo.badCount + indexedInfo.commentCount : (doc.bad?.length ?? 0);
  if(doc.kind === 'jsonl' && settings.strictJsonl && invalidLines > 0 && (indexedInfo?.records || doc.records?.length || 0) > 0){
    const retry = document.createElement('button');
    retry.className = 'doc-error-primary';
    retry.textContent = t('关闭严格模式并重试');
    retry.addEventListener('click', () => {
      settings.strictJsonl = false;
      saveSettings();
      optStrictJsonl.checked = false;
      activateDoc(doc.id);
    });
    retryButton = retry;
  }

  const close = document.createElement('button');
  close.textContent = t('关闭这份文件');
  close.addEventListener('click', () => closeDoc(doc.id));
  actions.appendChild(close);
  if(retryButton) actions.appendChild(retryButton);

  card.append(title, file, body, actions);
  docError.appendChild(card);
  docError.classList.add('show');
}

function hideDocError(){
  docError.classList.remove('show');
  docError.innerHTML = '';
}

/* ---------- 文件读取（多文件：每打开一个就追加一根条纹） ---------- */
chooseBtn.addEventListener('click', e => {
  e.stopPropagation();
  chooseFiles();
});
document.getElementById('sidebarOpenBtn').addEventListener('click', () => chooseFiles());
openAnotherBtn.addEventListener('click', () => chooseFiles());
for(const id of ['sidebarNewBtn','newDocBtn','newAnotherBtn']){
  document.getElementById(id).addEventListener('click', newBlankDocument);
}

fileInput.addEventListener('change', () => {
  openFiles(fileInput.files);
  fileInput.value = '';   /* 允许再次选择同一个文件 */
});

['dragenter','dragover'].forEach(type => {
  dropZone.addEventListener(type, e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
});
dropZone.addEventListener('dragleave', e => {
  if(!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if(!desktop && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

/* 打开阅读器后，整个窗口也支持拖入新 JSON（一次可拖多个） */
viewer.addEventListener('dragover', e => e.preventDefault());
viewer.addEventListener('drop', e => {
  e.preventDefault();
  if(!desktop && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

/* 一次打开多个文件（多选 / 拖入多个） */
function openFiles(fileList){
  return queueFiles([...fileList].filter(Boolean));
}

let pastedSequence = 0;
let blankSequence = 0;
function newBlankDocument(){
  if(templateEditing) return;
  let name;
  do { name = msg`未命名-${++blankSequence}.json`; } while(docs.some(doc => doc.name === name));
  const text = '{}\n';
  const doc = buildDoc(text, name, text.length);
  Object.assign(doc, { temporary:true, dirty:true, design:true, openPaths:['$'] });
  docs.push(doc);
  persistDesignDraft(doc);
  activateDoc(doc.id, []);
  viewport.focus({preventScroll:true});
}

function openPastedText(text){
  if(!text?.trim()){ showToast(t('剪贴板中没有文本')); return Promise.resolve(); }
  let base;
  do { base = msg`未命名-${++pastedSequence}`; } while(docs.some(d => d.name === `${base}.json` || d.name === `${base}.jsonl`));
  const file = new File([text], `${base}.json`, { type:'application/json' });
  if(file.size > MAX_FILE_BYTES){ showToast(t('粘贴内容超过 256 MiB，无法打开')); return Promise.resolve(); }
  file.temporary = true;
  return openFiles([file]);
}

// Preserve native paste in editors, search fields, dialogs and editable controls.
document.addEventListener('paste', e => {
  if(e.defaultPrevented || e.target?.closest?.('input,textarea,select,[contenteditable]')
    || ['valueEditDialog','designTopicDialog','discardEditDialog','deleteTopicDialog','saveConflictDialog','aboutDialog','updateDialog'].some(id => document.getElementById(id).open)
    || templateEditing || ['settingsMask','modalMask'].some(id => document.getElementById(id).classList.contains('open'))) return;
  const text = e.clipboardData?.getData('text/plain');
  if(!text?.trim()) return;
  e.preventDefault();
  openPastedText(text);
});

let pickingFiles = false;
async function chooseFiles(){
  if(!desktop){ fileInput.click(); return; }
  if(pickingFiles) return;
  pickingFiles = true;
  try{ openPaths(await selectNativeFiles()); }
  catch(error){ showToast(t('无法选择文件：') + error); }
  finally{ pickingFiles = false; }
}

function filePathKey(path){
  return (navigator.userAgentData?.platform || navigator.platform || '').startsWith('Win') ? path.toLowerCase() : path;
}

function openPaths(paths, sessions, preferred = null){
  return queueFiles(paths.map(path => ({ path })), sessions, preferred);
}

function queueFiles(files, sessions, preferred){
  const batch = {};
  const jobs = files.map(file => {
    const key = file.path && filePathKey(file.path);
    const existing = key && fileLoads.find(job => job.key === key);
    if(existing){
      if(file.resumeId) existing.file.resumeId = file.resumeId;
      if(sessions) existing.sessions = sessions;
      else existing.batch = batch;
      return existing;
    }
    const job = { id:`load-${++loadSequence}`, loadOrder:loadSequence, file, path:file.path, key,
      name:file.name || file.path.split(/[\\/]/).pop(), sessions, batch };
    job.done = new Promise(resolve => { job.finish = resolve; });
    fileLoads.push(job);
    return job;
  });
  if(!jobs.length) return Promise.resolve();
  const preferredKey = preferred && filePathKey(preferred);
  const target = sessions
    ? !selectedLoad && !activeDoc() && (jobs.find(job => job.key === preferredKey) || jobs[0])
    : jobs[0];
  if(target) prioritizeFileLoad(target);
  else renderRail();
  saveReopenCopy();
  if(!drainingLoads){
    drainingLoads = true;
    Promise.resolve().then(drainFileLoads);
  }
  return Promise.all(jobs.map(job => job.done));
}

function prioritizeFileLoad(job){
  selectedLoad = job;
  wakeBackgroundLoad?.();
  loadingStatus.hidden = runningLoad !== job;
  if(runningLoad && runningLoad !== job) runningLoad.controller.abort();
  renderRail();
  saveReopenCopy();
}

function cancelFileLoad(job){
  const index = fileLoads.indexOf(job);
  if(index < 0) return;
  fileLoads.splice(index, 1);
  if(selectedLoad === job) selectedLoad = null;
  if(runningLoad === job){
    job.controller.abort();
    loadingStatus.hidden = true;
  }else job.finish();
  if(!fileLoads.length) wakeBackgroundLoad?.();
  renderRail();
  saveReopenCopy();
}

function waitForBackgroundLoad(){
  return new Promise(resolve => {
    const idle = window.requestIdleCallback(() => {
      wakeBackgroundLoad = null;
      resolve();
    }, { timeout:180 });
    wakeBackgroundLoad = () => {
      window.cancelIdleCallback(idle);
      wakeBackgroundLoad = null;
      resolve();
    };
  });
}

async function drainFileLoads(){
  try{
    while(fileLoads.length){
      if(!selectedLoad && activeDoc() && typeof window.requestIdleCallback === 'function'){
        await waitForBackgroundLoad();
        if(!fileLoads.length) break;
      }
      const job = selectedLoad || fileLoads[0];
      runningLoad = job;
      job.controller = new AbortController();
      await loadFile(job.file, job.sessions, job);
      runningLoad = null;
      const index = fileLoads.indexOf(job);
      if(index >= 0 && job.controller.signal.aborted) continue;
      if(index >= 0) fileLoads.splice(index, 1);
      const wasSelected = selectedLoad === job;
      if(wasSelected) selectedLoad = null;
      job.finish();
      if(wasSelected || !fileLoads.length) renderRail();
      else scheduleRailRefresh();
      saveReopenCopy();
    }
  }finally{
    runningLoad = null;
    drainingLoads = false;
  }
}

function parseInBackground(payload, signal){
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser.worker.js', import.meta.url), { type: 'module' });
    const finish = (error, value) => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new DOMException(t('已取消打开'), 'AbortError'));
    if(signal.aborted){ abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data);
    worker.onerror = event => finish(new Error(event.message || t('后台解析失败')));
    worker.postMessage({ ...payload, language: getLanguage() }, payload.bytes ? [payload.bytes] : []);
  });
}

async function loadFile(file, sessions, job = null){
  const threshold = settings.largeFileThresholdMiB;
  if(!file.path && needsIndex(file.size, threshold)){
    showToast(msg`文件超过 ${threshold} MB 的读取上限。请在设置中提高阈值，或用桌面版从本机路径打开。`);
    return;
  }
  if(!file.path && !/\.(json|jsonl|ndjson|jsonlines|txt)$/i.test(file.name)){
    showToast(msg`已跳过 ${file.name}：不支持的文件格式`); return;
  }
  const controller = job?.controller || new AbortController();
  activeLoad = controller;
  loadingStatus.hidden = !!job && selectedLoad !== job && !!activeDoc();
  const name = file.name || file.path?.split(/[\\/]/).pop();
  loadingLabel.textContent = name ? msg`正在读取 ${name}…` : t('正在读取文件…');
  loadingProgress.removeAttribute('value');
  let indexedSource = null;
  let attached = false;
  let lastPercent = -1;
  try{
    const metadata = file.path ? await statNativeFile(file.path) : file;
    if(controller.signal.aborted) return;
    let result, text, source = metadata;
    if(file.path && needsIndex(metadata.size, threshold)){
      loadingLabel.textContent = t('正在扫描文件 · ') + metadata.name;
      indexedSource = await openIndexedFile(metadata, {
        signal: controller.signal, wrap: settings.jsonlWrapArray !== false, strict: !!settings.strictJsonl,
        reuse: settings.indexRebuild === 'smart',
        progress(bytes){
          if(controller.signal.aborted || loadingStatus.hidden) return;
          const percent = Math.min(100, Math.floor(bytes / Math.max(1, metadata.size) * 100));
          if(percent === lastPercent) return;
          lastPercent = percent;
          if(percent === 100){
            loadingProgress.removeAttribute('value');
            loadingLabel.textContent = t('正在完成索引 · ') + metadata.name;
          }else{
            loadingProgress.value = percent;
            loadingLabel.textContent = msg`正在扫描文件 · ${percent}% · ${metadata.name}`;
          }
        }
      });
      result = { kind: indexedSource.info.kind }; text = '';
    }else{
      const bytes = file.path ? await readNativeFile(metadata.path, threshold * 1024 ** 2) : null;
      controller.signal.throwIfAborted();
      if(bytes) source = { ...metadata, size:bytes.byteLength };
      loadingLabel.textContent = t('正在后台解析 ') + source.name + '…';
      ({ result, text } = await parseInBackground({
        name: source.name, size: source.size, file: file.path ? null : file,
        bytes, keepText: !!bytes || !desktop || !!file.temporary
      }, controller.signal));
    }
    if(controller.signal.aborted) return;
    if(file.temporary && result.error){ showToast(t('无法粘贴：') + result.error); return; }
    const doc = Object.assign(makeDoc(source.name, source.size, text, result.kind), result);
    if(indexedSource) doc.source = indexedSource;
    doc.path = source.path || null;
    if(file.temporary){
      doc.temporary = true; doc.dirty = true;
      if(doc.kind === 'jsonl') doc.name = doc.name.replace(/\.json$/, '.jsonl');
    }
    // Windows paths are case insensitive; native canonical paths identify documents.
    doc.identity = doc.path && filePathKey(doc.path);
    if(doc.kind === 'jsonl') doc.bad ||= [];
    const resumed = docs.find(d => d.id === file.resumeId);
    const duplicate = resumed || docs.find(d => doc.path ? docKey(d) === docKey(doc)
      : !file.temporary && !d.temporary && !d.path && d.name === doc.name && d.size === doc.size && d.text === doc.text);
    if(duplicate?.unloaded){
      Object.assign(duplicate, {
        name:doc.name, path:doc.path, identity:doc.identity, size:doc.size, text:doc.text, kind:doc.kind,
        parsed:doc.parsed, records:doc.records, bad:doc.bad, totalLines:doc.totalLines,
        error:doc.error, source:indexedSource, inactiveSince:Date.now()
      });
      restoreDocSession(duplicate, duplicate.resumeSession);
      delete duplicate.resumeSession;
      delete duplicate.unloaded;
      attached = true;
      if(!job || selectedLoad === job || !activeDoc()) activateDoc(duplicate.id);
      scheduleIndexVerification(duplicate);
    }else if(duplicate){
      if(duplicate.dirty && !await confirmDiscardEdits()) return;
      if(controller.signal.aborted) return;
      if(duplicate === activeDoc()) snapshotDoc();
      duplicate.dirty = false; duplicate.editHistory = [];
      duplicate.redoHistory = []; duplicate.ideEditGroup = null;
      persistDesignDraft(duplicate);
      duplicate.ideDraft = undefined; duplicate.ideError = undefined;
      duplicate.untypedTopics = undefined;
      duplicate.ideFolds = undefined; duplicate.ideProjection = undefined;
      duplicate.savedText = undefined; duplicate.diskText = undefined;
      duplicate.indexRebuild?.abort();
      duplicate.source?.dispose();
      Object.assign(duplicate, { parsed: doc.parsed, records: doc.records, bad: doc.bad,
        totalLines: doc.totalLines, text: doc.text, size: doc.size, editedSize:undefined, kind: doc.kind, error: doc.error,
        rootLabel: 'root', data: undefined, source: indexedSource });
      attached = true;
      if(!job || selectedLoad === job || activeDocId === duplicate.id) activateDoc(duplicate.id);
      scheduleIndexVerification(duplicate);
    }else{
      const savedSessions = job?.sessions || sessions || nativeRestore?.sessions;
      if(savedSessions) restoreDocSession(doc, sessionFor(doc, savedSessions));
      if(job){
        doc.loadOrder = job.loadOrder;
        const later = docs.findIndex(item => item.loadOrder > doc.loadOrder);
        docs.splice(later < 0 ? docs.length : later, 0, doc);
      }else docs.push(doc);
      attached = true;
      if(!job || selectedLoad === job || (!activeDoc() && !selectedLoad)) activateDoc(doc.id);
      scheduleIndexVerification(doc);
    }
    if(enforceResidentLimit()) scheduleRailRefresh();
    scheduleMemoryRelease();
    if(!job) saveReopenCopy();
  }catch(error){
    if(error.name !== 'AbortError') showToast(t('打开失败：') + (error.message || String(error)));
  }finally{
    if(indexedSource && !attached) indexedSource.dispose();
    if(activeLoad === controller){ activeLoad = null; loadingStatus.hidden = true; }
  }
}

// Run hashes one at a time, after the newly mounted tree gets a paint.
let indexVerification = Promise.resolve();
function scheduleIndexVerification(doc){
  const source = doc?.source;
  if(nativeRestore || !source?.indexed) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    indexVerification = indexVerification.then(async () => {
      // Hashing reads the entire source again. Wait for the file queue before
      // starting another read, especially when indexes are being restored.
      while(fileLoads.length && docs.includes(doc) && doc.source === source){
        await fileLoads.at(-1).done;
      }
      if(!docs.includes(doc) || doc.source !== source) return;
      if(!await source.verifyIndex() && docs.includes(doc) && doc.source === source){
        await rebuildChangedIndex(doc, source);
      }
    }).catch(error => {
      if(docs.includes(doc) && doc.source === source) console.warn(t('未能保存大文件索引'), error);
    });
  }));
}

async function rebuildChangedIndex(doc, source){
  const controller = new AbortController();
  doc.indexRebuild = controller;
  renderRail();
  let replacement;
  if(doc === activeDoc()) showToast(msg`${doc.name} 已变化，正在后台重建索引`);
  try{
    const metadata = await statNativeFile(doc.path);
    replacement = await openIndexedFile(metadata, {
      signal:controller.signal, wrap:settings.jsonlWrapArray !== false,
      strict:!!settings.strictJsonl, reuse:settings.indexRebuild === 'smart'
    });
    if(controller.signal.aborted || doc.source !== source || !docs.includes(doc)) return;
    if(doc === activeDoc()) snapshotDoc();
    source.dispose();
    Object.assign(doc, { source:replacement, size:metadata.size, kind:replacement.info.kind, error:null });
    replacement = null;
    if(doc === activeDoc()) activateDoc(doc.id);
    else renderRail();
    scheduleIndexVerification(doc);
  }catch(error){
    if(!controller.signal.aborted && doc.source === source) {
      showToast(t('重建索引失败：') + (error.message || String(error)));
    }
  }finally{
    replacement?.dispose();
    if(doc.indexRebuild === controller){
      doc.indexRebuild = null;
      if(docs.includes(doc)){
        enforceResidentLimit();
        scheduleMemoryRelease();
        renderRail();
      }
    }
  }
}

/* ---------- 「刷新后继续打开」：整组文件 + 各自的阅读会话 ---------- */
/* 把已打开的文件集合写入本地，刷新后整体恢复。
   未开启该设置时不碰 localStorage；配额不足时退化为只保存当前文件 */
function saveReopenCopy(notify = showToast){
  if(!settings.reopenLast) return;

  if(!docs.length && !fileLoads.length){
    try{
      localStorage.removeItem(LASTFILE_KEY);
      localStorage.removeItem(SESSION_KEY);
    }catch(_){}
    return;
  }

  if(desktop){
    const files = new Map(docs.filter(doc => doc.path).map(doc => [docKey(doc), {
      path:doc.path, name:doc.name, size:doc.size, kind:doc.kind
    }]));
    for(const job of fileLoads) if(job.key && !files.has(job.key)) files.set(job.key, { path:job.path });
    const snapshot = { version: 3,
      activeKey: selectedLoad?.key || (activeDoc() ? docKey(activeDoc()) : files.keys().next().value),
      docs: [...files.values()], savedAt: Date.now() };
    try{ localStorage.setItem(LASTFILE_KEY, JSON.stringify(snapshot)); }
    catch(_){ notify(t('未能保存文件列表')); }
    return;
  }
  if(!docs.length) return;

  const reopenable = docs.filter(doc => !(doc.design || doc.draftKey) || !doc.dirty || doc.draftWriteFailed);
  const snapshot = active => ({
    version: 2,
    activeKey: docKey(active),
    docs: reopenable.map(d => ({
      name: d.name, size: d.size, editedSize:d.editedSize, kind: d.kind,
      text: d.text, rootLabel: d.rootLabel, temporary:!!d.temporary, dirty:!!d.dirty, design:!!d.design
    })),
    savedAt: Date.now()
  });

  try{
    localStorage.setItem(LASTFILE_KEY, JSON.stringify(snapshot(activeDoc() || docs[0])));
    return;
  }catch(_){}

  /* 文件太多 / 太大：退化为只保留当前文件，保证核心的「刷新后继续打开」仍可用 */
  const cur = reopenable.find(doc => doc === activeDoc()) || reopenable[0];
  if(!cur) return;
  try{
    localStorage.setItem(LASTFILE_KEY, JSON.stringify({
      version: 2,
      activeKey: docKey(cur),
      docs: [{ name: cur.name, size: cur.size, editedSize:cur.editedSize, kind: cur.kind, text: cur.text, rootLabel: cur.rootLabel, temporary:!!cur.temporary, dirty:!!cur.dirty, design:!!cur.design }],
      savedAt: Date.now()
    }));
    notify(t('恢复空间不足，刷新后只会打开当前文件'));
  }catch(_){
    notify(t('文件过大，未能保存刷新恢复副本'));
  }
}

/* ---------- 阅读会话：每个文档的展开状态 + 视图位置 ---------- */
/* 只收集体积很小的会话数据；文件原文在副本里，不跟着一起重写 */
function collectSession(){
  if(!settings.reopenLast || !settings.restoreSession) return null;

  /* 当前文档的展开 / 平移状态先落到文档对象上，再整体收集 */
  snapshotDoc();

  const map = {};
  for(const job of fileLoads){
    const session = job.sessions?.[job.key];
    if(session) map[job.key] = session;
  }
  docs.forEach(d => {
    map[docKey(d)] = d.resumeSession || {
      paths:d.openPaths, view:d.view, pageOffsets:d.pageOffsets,
      viewMode:d.viewOverride, design:d.design || undefined, designPreviousView:d.designPreviousView,
      ide:d.ideZoom || d.ideSelection || d.ideFolds?.size ? {
        zoom:d.ideZoom, scrollTop:d.ideScrollTop, scrollLeft:d.ideScrollLeft,
        selection:d.ideSelection, folds:d.ideFolds && [...d.ideFolds]
      } : undefined
    };
  });
  return { version: 3, docs: map, savedAt: Date.now() };
}

/* 展开 / 平移后延迟落盘：拖动过程中不会每一帧都写 localStorage */
let sessionSaveTimer = null;
let sessionSaveFailed = false;
function scheduleSessionSave(){
  if(!settings.reopenLast || !settings.restoreSession) return;

  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 400);
}

function saveSession(notify = showToast){
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;

  const session = collectSession();
  if(!session) return;

  try{
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    sessionSaveFailed = false;
  }catch(_){
    if(!sessionSaveFailed) notify(t('未能保存阅读位置'));
    sessionSaveFailed = true;
  }
}

/* 直接套用刷新前的平移 / 缩放（此时不再把某个节点居中） */
function applySessionView(view){
  if(!view) return;

  mainView.state.x = Number(view.x) || 0;
  mainView.state.y = Number(view.y) || 0;
  mainView.state.scale = clamp(Number(view.scale) || 1, MIN_SCALE, MAX_SCALE);
  mainView.apply();
}

/* 页面隐藏 / 关闭前补一次，避免最后几百毫秒的操作没落盘 */
window.addEventListener('pagehide', () => saveSession());

/* 打开时的展开策略：模板优先，其次默认层级。
   「刷新后恢复」由 activateDoc 直接按文档自己的会话铺开，不走这里 */
async function applyOpenPolicy(){
  let focusNode = null;

  if(settings.autoTemplate && template && template.paths.length){
    focusNode = await applyTemplate();
  }else if(settings.defaultLevels > 0){
    await expandLevels(tree.firstElementChild, settings.defaultLevels);
  }
  if(focusNode) requestAnimationFrame(() => { if(focusNode.isConnected) centerNode(focusNode); });
  return focusNode;
}

/* 撤回阅读器视图，回到落地页（关掉最后一份文件时用） */
function withdrawView(){
  closeEditor();
  ideActive = false; ideLocations = new Map();
  document.getElementById('ideInput').value = '';
  document.getElementById('ideLines').replaceChildren();
  nodeBudget.reset(); updateNodeBudgetNotice();
  viewportWindow.clear();
  discardPagedTree(tree);
  activeDocId = null;
  if(settingsMask.classList.contains('open')) updateTemplateStatus();
  parsedData = null;
  currentRootLabel = 'root';
  updateWindowTitle(null);
  tree.innerHTML = '';
  renderRail();
  hideDocError();
  resetSearchState();
  closeFindPanel(false);
  viewer.style.display = 'none';
  landing.style.display = 'grid';
  syncPendingRail();
}

/* ---------- 树渲染 ---------- */
function renderTree(data, rootLabel){
  nodeBudget.reset(); updateNodeBudgetNotice();
  viewportWindow.clear();
  expansionGeneration++;
  discardPagedTree(tree);
  const doc = activeDoc();
  if(!doc.source?.matches(data)){
    doc.source?.dispose();
    doc.source = new MemoryDataSource(data);
  }
  tree.innerHTML = '';
  const root = createNode(rootLabel || 'root', doc.source.getRoot(), [], true, false, doc.source);
  tree.appendChild(root);
  syncReadingActions();

  /* 初始全部收起，只显示根节点 */
  root.classList.remove('open');

  updateVirtualization();
  scheduleOverflowSweep();
}

/* ---------- 虚拟化开关（方案A） ----------
   节点超过阈值才开启 content-visibility，
   小文件保持精确渲染，大文件换取平移流畅 */
const CV_THRESHOLD = 1500;
const nodeBudget = new NodeBudget(tree, { viewport });
const nodeBudgetNotice = document.getElementById('nodeBudgetNotice');
const reclaimNodesBtn = document.getElementById('reclaimNodesBtn');
function updateNodeBudgetNotice(count){
  nodeBudgetNotice.hidden = !nodeBudget.update(count);
}
const nodeLimitToastTime = new WeakMap();
function showNodeLimit(scope = tree, message = t('已达到 5000 个显示节点，可精简远处内容后继续展开')){
  const now = Date.now();
  if(now - (nodeLimitToastTime.get(scope) ?? -Infinity) >= 1600){
    nodeLimitToastTime.set(scope, now);
    showToast(message);
  }
  if(scope === tree){ nodeBudget.notify(); updateNodeBudgetNotice(); }
}
reclaimNodesBtn.addEventListener('click', () => {
  expansionGeneration++; focusGeneration++;
  const vp = viewport.getBoundingClientRect?.();
  const anchor = vp && [...tree.querySelectorAll('.tree-node')].find(node => {
    const r = nodeBudget.bounds(node);
    return r && r.bottom > vp.top && r.top < vp.bottom && r.right > vp.left && r.left < vp.right;
  });
  const before = anchor?.getBoundingClientRect();
  const { removed } = nodeBudget.reclaim(vp);
  if(anchor?.isConnected){
    const after = anchor.getBoundingClientRect();
    mainView.state.x += before.left - after.left; mainView.state.y += before.top - after.top; mainView.apply();
  }
  updateVirtualization(); scheduleOverflowSweep();
  if(nodeBudgetNotice.hidden) expandAllBtn.focus();
  showToast(removed ? msg`已精简 ${removed} 个远处节点，可通过“查看此处”或搜索重新访问` : t('当前没有可精简的远处未阅读节点，可手动收起部分分支'));
});
tree.addEventListener('click', event => {
  if(settings.branchLineAction === 'off' || !event.target.classList.contains('branch-line-target')) return;
  const parent = canvasParent(event.target.parentElement);
  if(!parent?.classList.contains('open')) return;
  if(settings.branchLineAction === 'collapse') collapseSubtree(parent);
  focusGeneration++;
  selectCopyNode(parent);
  selectedSearchPath = parent._source === activeDoc()?.source ? [...parent._path] : null;
  pathText.textContent = t('路径：') + parent.dataset.path;
  viewport.focus({preventScroll:true});
  centerNode(parent, parent.firstElementChild);
});
tree.addEventListener('pointerdown', e => {
  if(e.target.classList.contains('branch-line-target')) return;
  const node = e.target.closest('.tree-node'); nodeBudget.touch(node);
  if(node && node._source === activeDoc()?.source) selectedSearchPath = [...node._path];
  if(node && e.target.closest('.node-card') && !e.target.closest('button,input,select')){
    selectCopyNode(node); viewport.focus({preventScroll:true});
  }
});
tree.addEventListener('focusin', e => nodeBudget.touch(e.target.closest('.tree-node')));

function updateVirtualization(){
  const n = tree.querySelectorAll('.tree-node').length;
  nodeBudget.observe(tree.querySelectorAll('.tree-node'));
  // Reaching the count alone is normal for wide files. Prompt only when an
  // explicit expansion actually stops at the budget (showNodeLimit).
  updateNodeBudgetNotice(n);
  tree.classList.toggle('virtualized', n > CV_THRESHOLD && !activeDoc()?.source?.indexed);
  if(viewportWindow.enabled && activeDoc()?.source?.indexed){
    for(const node of tree.querySelectorAll('.tree-node')){
      if(node._source?.indexed && node._setPageRetained){
        const children = directChildrenContainer(node);
        if(children) viewportWindow.watch(children, {
          suspend: () => { node._setPageRetained(false); },
          resume: () => { node._setPageRetained(true); }
        });
      }
      if(node._source?.indexed && !node.classList.contains('branch') && !node.classList.contains('root-node') && !node._jsonSource) observeLeaf(node);
    }
  }
  scheduleSessionSave();   /* 树的结构变了：展开状态要记进会话 */
}

function syncReadingActions(){
  const indexed = !!activeDoc()?.source?.indexed;
  expandAllBtn.textContent = indexed ? t('展开当前页') : t('展开全部');
  expandAllBtn.title = (indexed ? t('逐层展开各分支的当前页，最多显示约 5000 个节点') : t('展开全部节点，最多显示约 5000 个节点')) + `（${shortcutText('expandAll')}）`;
  document.getElementById('ctxExpandSubtree').textContent = indexed ? t('展开当前页的下级') : t('展开全部下级');
}

// Keep only identity and geometry off screen. Branches retain their lightweight
// structure, expansion state and page cursor; payload cards are recreated on demand.
function observeLeaf(node){
  viewportWindow.watch(node, {
    suspend(){
      if(node.classList.contains('branch') || node._jsonSource || node.classList.contains('current-match')) return false;
      const main = node.firstElementChild;
      if(!main || main.offsetWidth <= 0 || main.offsetHeight <= 0) return false;
      const rect = main.getBoundingClientRect();
      const scale = lastViewState?.scale || 1;
      const shell = document.createElement('button');
      shell.type = 'button'; shell.className = 'node-main viewport-placeholder';
      shell.style.width = rect.width / scale + 'px'; shell.style.height = rect.height / scale + 'px';
      shell.textContent = t('加载内容…'); shell.setAttribute('aria-label', t('加载字段 ') + node._key);
      shell.addEventListener('click', wakeViewportNode);
      main.replaceWith(shell);
      node._searchValue = ''; node._keyEl = null; node.dataset.searchText = '';
      node.classList.add('viewport-sleeping');
      return true;
    },
    async resume(signal){
      try {
        const path = node._sourcePath;
        const page = await node._source.getChildren(path.slice(0,-1), { key: path.at(-1), signal });
        signal.throwIfAborted();
        if(!node.isConnected) return false;
        const descriptor = page.items.find(item => item.key === path.at(-1));
        if(!descriptor) throw new Error(t('节点不存在'));
        node.parentElement?.parentElement?._rememberPage?.(page);
        const fresh = createNode(node._isArrayItem ? arrayIndexLabel(path.at(-1)) : node._key,
          descriptor, node._path, false, node._isArrayItem, node._source);
        node.firstElementChild.replaceWith(fresh.firstElementChild);
        node._keyEl = fresh._keyEl; node._searchValue = fresh._searchValue;
        node.dataset.searchText = fresh.dataset.searchText;
        node.classList.remove('viewport-sleeping');
        scheduleOverflowSweep(); return true;
      }catch(error){
        if(!signal.aborted && node.isConnected){
          node.firstElementChild.textContent = t('加载失败，点击重试');
          node.firstElementChild.title = error.message || String(error);
        }
        return false;
      }
    }
  });
}
function wakeViewportNode(event){ event.currentTarget.parentElement?._wakeViewport?.(); }

/* ---------- 字符串里的 JSON ----------
   只认「外形是对象 / 数组、且真的能解析」的字符串，避免把普通文本误判成 JSON */
function parseJsonInString(text){
  if(typeof text !== 'string') return undefined;

  const s = text.trim();
  if(s.length < 2) return undefined;

  const head = s[0], tail = s[s.length - 1];
  const looksLikeJson = (head === '{' && tail === '}') || (head === '[' && tail === ']');
  if(!looksLikeJson) return undefined;

  try{
    const parsed = JSON.parse(s);
    return (parsed !== null && typeof parsed === 'object') ? parsed : undefined;
  }catch(_){
    return undefined;
  }
}

/* 数组元素在树中显示的序号：由设置决定 0 基 / 1 基。
   只作用于显示标签与搜索文本；JSONPath、模板、会话一律使用真实下标，
   保证节点身份不因显示偏好而改变 */
function arrayIndexLabel(index){
  const n = Number(index);
  return String(settings.indexBase === 1 ? n + 1 : n);
}

/* 挂载子节点容器与展开逻辑：分支节点、以及「字符串型 JSON」升级后的节点共用 */
function attachChildren(node, card, toggle, source, sourcePath, path){
  const children = document.createElement('div');
  children.className = 'children';
  node.appendChild(children);

  const hidden = activeDoc()?.design ? new Set() : getHiddenSet();
  const ensureChildren = pagedChildren(node, children, source, sourcePath, item => {
    if(hidden.size && hidden.has(normalizePath(encodePath(path.concat(item.key))))) return null;
    return createNode(item.arrayItem ? arrayIndexLabel(item.key) : String(item.key), item,
      path.concat(item.key), false, item.arrayItem, source);
  }, () => { updateVirtualization(); scheduleOverflowSweep(); }, false, first => {
    focusGeneration++;
    centerNode(first?._path ? first : node);
  });

  const toggleNode = e => {
    e.stopPropagation();
    expansionGeneration++;
    nodeBudget.touch(node);
    node.classList.toggle('open');
    if(node.classList.contains('open')) ensureChildren();
    else node._discardChildren?.();
    updateVirtualization();
    scheduleOverflowSweep();
  };

  toggle.addEventListener('click', toggleNode);
  card.addEventListener('click', e => { if(!activeDoc()?.design) toggleNode(e); });
}

/* 字符串的原文仍由原数据源读取；解析出的结构使用独立的数据源。 */
function buildJsonChildren(node){
  const source = node._jsonSource;
  if(!source || node._jsonTreeReady) return;

  const main = node.querySelector(':scope > .node-main');
  const toggle = main?.querySelector('.toggle');
  const card = main?.querySelector('.node-card');
  if(!toggle || !card) return;

  node._jsonTreeReady = true;
  node.classList.add('branch');
  card.classList.add('json-expanded');

  /* 叶子节点原本的 chevron 是占位不可见的，升级后启用 */
  toggle.classList.remove('placeholder');
  toggle.title = t('展开 / 收起该字段解析出的 JSON');

  node._childrenType = source.getRoot().type;
  attachChildren(node, card, toggle, source, [], node._path || []);
  updateVirtualization();
}

/* 角标点击：首次点击构造 JSON 子树，之后与 chevron 一致地展开 / 收起 */
function expandJsonField(node){
  nodeBudget.touch(node);
  expansionGeneration++;
  if(!node._jsonTreeReady) buildJsonChildren(node);
  if(!node._jsonTreeReady) return;

  if(!node.classList.contains('open')) node._ensureChildren?.();
  node.classList.toggle('open');
  if(!node.classList.contains('open')) node._discardChildren?.();
  updateVirtualization();

  /* 原始字符串的显示形态变了（多行原文 ↔ 单行摘要），这张卡片要重测一次 */
  const card = node.querySelector(':scope > .node-main > .node-card');
  if(card) refreshValueOverflow(card, true);
  scheduleOverflowSweep();
}

/* ---------- 卡片右上角图标容器 ---------- */
/* 按需创建：卡片本来没有右上角图标时，不产生多余 DOM */
function cardIconsOf(card){
  let box = card.querySelector(':scope > .card-icons');
  if(!box){
    box = document.createElement('div');
    box.className = 'card-icons';
    card.appendChild(box);
  }
  return box;
}

function dropEmptyCardIcons(card){
  const box = card.querySelector(':scope > .card-icons');
  if(box && !box.children.length) box.remove();
}

/* … 图标：值超出最大高度时出现，点击在弹窗中查看完整内容 */
function createFullViewBadge(card){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-chip fullview-badge';
  btn.textContent = '…';
  btn.title = t('内容超出最大高度，点击查看完整内容');
  btn.setAttribute('aria-label', t('查看完整内容'));

  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    const node = card.closest('.tree-node');
    if(node) openModal(node);
  });

  return btn;
}

function setFullViewIcon(card, show){
  const existing = card.querySelector(':scope > .card-icons > .fullview-badge');

  if(show && !existing){
    cardIconsOf(card).appendChild(createFullViewBadge(card));
    card.classList.add('has-fullview');
  }else if(!show && existing){
    existing.remove();
    card.classList.remove('has-fullview');
    dropEmptyCardIcons(card);
  }
}

/* 只有真正超出设定高度的值才挂 … 图标。
   高度靠布局测量：收起的节点里没有布局，先跳过，等展开时再量 */
function refreshValueOverflow(scope, force){
  if(!settings.limitValueHeight) return;

  const rootEl = scope || tree;
  const els = rootEl.classList.contains('node-value')
    ? [rootEl]
    : [...rootEl.querySelectorAll('.node-value')];

  /* 先挑出没量过的：没有待测对象时，连下面的全量渲染都不必做 */
  const pending = [];
  for(const el of els){
    const card = el.closest('.node-card');
    if(card && (force || !card._ovMeasured)) pending.push([el.closest('.node-text') || el, card]);
  }
  if(!pending.length) return;

  /* 虚拟化时屏外子树没有真实布局，测量前临时全量渲染（与 centerNode 同一手法） */
  const wasVirt = tree.classList.contains('virtualized');
  if(wasVirt) tree.classList.add('no-cv');

  for(const [el, card] of pending){
    if(!el.offsetParent) continue;   /* 收起节点里的值量不了，留给下次 */

    card._ovMeasured = true;
    setFullViewIcon(card, card._previewTruncated || el.scrollHeight - el.clientHeight > 1);
  }

  if(wasVirt) tree.classList.remove('no-cv');
}

/* 结构变化后统一重扫；同一轮里的多次调用合并成一次，已量过的卡片直接跳过。
   用定时器而不是 rAF 调度：后台标签页里 rAF 不触发，会导致内容被截断却没有图标 */
let overflowSweepHandle = null;
function scheduleOverflowSweep(){
  if(!settings.limitValueHeight || overflowSweepHandle) return;
  overflowSweepHandle = setTimeout(() => {
    overflowSweepHandle = null;
    refreshValueOverflow(tree);
  }, 0);
}

function createJsonBadge(node){
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-chip json-badge';
  btn.textContent = '{}';
  btn.title = t('该字段的内容是 JSON 文本，点击以 JSON 展开');
  btn.setAttribute('aria-label', t('将该字段以 JSON 展开'));

  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    expandJsonField(node);
  });

  return btn;
}

function createNodeToggle(isBranch){
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle' + (isBranch ? '' : ' placeholder');
  if(isBranch) toggle.setAttribute('aria-label', t('展开或收起节点'));
  toggle.innerHTML = '<svg class="chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.25 2.5 7.75 6 4.25 9.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return toggle;
}

function createNode(key, descriptor, path, isRoot=false, isArrayItem=false, source){
  const isBranch = descriptor.type === 'object' || descriptor.type === 'array';
  const value = descriptor.value;
  const doc = activeDoc();
  const nodePath = encodePath(path);
  const untyped = doc?.design && doc.source === source && doc.untypedTopics?.has(nodePath);

  const node = document.createElement('div');
  node.className = 'tree-node'
    + (isBranch ? ' branch' : '')
    + (isRoot ? ' root-node' : '');
  node.dataset.path = nodePath;
  if(searchOptions.scopePath && node.dataset.path === encodePath(searchOptions.scopePath)) node.classList.add('search-scope-node');
  node.dataset.searchText =
    `${String(key)} ${isBranch ? descriptor.type : String(value)}`.toLowerCase();
  /* 保留原始值，供弹窗/复制使用；路径供 JSON 展开时拼接子节点用 */
  node._source = source;
  node._sourcePath = descriptor.path;
  node._childrenType = descriptor.type;
  node._searchValue = isBranch ? descriptor.type : String(value);
  node._key = String(key);
  node._path = path;
  node._isArrayItem = isArrayItem;   /* 数组元素：序号标签可随设置实时切换 */

  const main = document.createElement('div');
  main.className = 'node-main';

  const toggle = createNodeToggle(isBranch);

  const card = document.createElement('div');
  card.className = 'node-card';
  node._card = card;

  const keyEl = document.createElement('span');
  keyEl.className = 'node-key';
  keyEl.textContent = key;
  node._keyEl = keyEl;

  if(isBranch || untyped){
    card.appendChild(keyEl);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = untyped ? t('未指定类型') : `${descriptor.type === 'array' ? 'Array' : 'Object'} · ${descriptor.childCount}`;
    card.appendChild(badge);
  }else{
    const text = document.createElement('span');
    text.className = 'node-text';
    const sep = document.createElement('span');
    sep.className = 'node-sep';
    sep.textContent = ' : ';

    const valueEl = document.createElement('span');
    valueEl.className = 'node-value ' + typeClass(value);
    valueEl.textContent = formatPrimitive(value);
    text.append(keyEl, sep, valueEl);
    card.appendChild(text);
    if(descriptor.truncated){
      card._previewTruncated = true;
      setFullViewIcon(card, true);
      card.title = t('长字段仅显示预览，点击 … 读取全文（上限 8 MiB）');
    }

    /* 该字段的内容本身就是 JSON：右上角给角标，点击即以 JSON 展开 */
    const jsonValue = descriptor.truncated ? undefined : parseJsonInString(value);
    if(jsonValue !== undefined){
      node._jsonSource = new MemoryDataSource(jsonValue);
      card.classList.add('has-json-badge');
      cardIconsOf(card).appendChild(createJsonBadge(node));
    }
  }

  main.append(toggle, card);
  node.appendChild(main);

  /* 点击节点显示完整 JSONPath */
  card.addEventListener('mouseenter', () => {
    pathText.textContent = t('路径：') + node.dataset.path;
  });
  card.addEventListener('mouseleave', () => {
    pathText.textContent = t('路径：$');
  });

  if(!isRoot){
    const lineTarget = document.createElement('button');
    lineTarget.type = 'button';
    lineTarget.className = 'branch-line-target';
    lineTarget.tabIndex = -1;
    lineTarget.setAttribute('aria-label', t('跳到父节点'));
    node.appendChild(lineTarget);
  }
  if(isBranch) attachChildren(node, card, toggle, source, descriptor.path, path);

  return node;
}

async function expandVisible(root, scope = tree){
  if(!root) return;
  const generation = ++expansionGeneration;
  const docId = activeDocId;
  const stack = [root];
  let visited = 0, stoppedAtLimit = false;
  while(stack.length){
    if(generation !== expansionGeneration || docId !== activeDocId || !root.isConnected) return;
    if(scope.querySelectorAll('.tree-node').length >= 5000){
      showNodeLimit(scope);
      stoppedAtLimit = true;
      break;
    }
    const node = stack.pop();
    if(node.isConnected === false) continue;
    if(!node.classList.contains('branch')) continue;
    await node._ensureChildren?.();
    if(generation !== expansionGeneration || docId !== activeDocId || !root.isConnected) return;
    node.classList.add('open');
    const children = directChildrenContainer(node);
    if(children) stack.push(...[...children.children].filter(n => n.classList.contains('tree-node')));
    if(++visited % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  updateVirtualization();
  scheduleOverflowSweep();
  if(!stoppedAtLimit && scope.querySelector('.page-navigation')) showToast(t('已展开各分支的当前页。可在分支底部加载更多。'));
}

function expandAll(){ return expandVisible(tree.firstElementChild); }

function collapseAll(){
  expansionGeneration++;
  tree.firstElementChild?._discardChildren?.();
  tree.querySelectorAll('.tree-node.open')
    .forEach(n => n.classList.remove('open'));
  updateVirtualization();
}

/* ---------- 选中节点的子树展开 / 收起 ---------- */
const ctxMenu = document.getElementById('ctxMenu');
const topicMenu = document.getElementById('topicMenu');
const topicMenuActions = [
  ['ctxTopicChild','child'], ['ctxTopicSibling','sibling'],
  ['ctxTopicRename','rename'], ['ctxTopicDelete','delete']
];
const contextMenuItems = [
  'ctxCopyPath', 'ctxExpandSubtree', 'ctxCollapse', 'ctxEditNode',
  'ctxHideNode', 'ctxViewFull', 'ctxCopy'
].map(id => {
  const button = document.getElementById(id);
  return { id, button, label: button.textContent };
});
const contextMenuHiddenByDefault = new Set(['ctxViewFull', 'ctxCopy']);

function normalizeContextMenu(value){
  const remaining = new Set(contextMenuItems.map(item => item.id));
  const items = [];
  if(Array.isArray(value)){
    for(const item of value){
      if(item && remaining.delete(item.id)) items.push({id:item.id, enabled:item.enabled !== false});
    }
  }
  for(const id of remaining) items.push({id, enabled:!contextMenuHiddenByDefault.has(id)});
  return items;
}
const canvasMenu = document.getElementById('canvasMenu');
const ctxCopyPath = document.getElementById('ctxCopyPath');
const ctxExpandSubtreeBtn = document.getElementById('ctxExpandSubtree');
const ctxCollapseBtn = document.getElementById('ctxCollapse');
let ctxTarget = null;

/* 展开该节点的一级子节点 */
async function expandOne(node, key, offset){
  if(!node.classList.contains('branch')) return;
  node.classList.add('open');
  await node._ensureChildren?.(key, offset);
  if(node.isConnected === false) return;
  updateVirtualization();
  scheduleOverflowSweep();
}

/* 递归展开该节点下所有层级 */
function expandSubtree(node){ return expandVisible(node); }

/* 收起该节点，并将其下所有已展开的节点一并置为收起 */
function collapseSubtree(node){
  expansionGeneration++;
  node._discardChildren?.();
  node.classList.remove('open');
  /* querySelectorAll 不含自身，只处理后代 */
  node.querySelectorAll('.tree-node.open')
    .forEach(n => n.classList.remove('open'));
  updateVirtualization();
}

function isBranchEl(node){
  return node.classList.contains('branch');
}

function openMenu(x, y){
  const topic = designTarget(ctxTarget);
  if(!topic && !settings.contextMenu.some(item => item.enabled)) {
    closeMenu();
    return;
  }
  canvasMenu.hidden = true;
  topicMenu.hidden = !topic;
  ctxMenu.classList.toggle('topic-menu', !!topic);

  /* 叶子节点禁用展开项 */
  const branch = isBranchEl(ctxTarget);
  ctxCopyPath.disabled = !ctxTarget?.dataset.path;
  ctxExpandSubtreeBtn.disabled = !branch;
  ctxCollapseBtn.disabled = !branch || !ctxTarget.classList.contains('open');
  document.getElementById('ctxTopicCollapse').disabled = ctxCollapseBtn.disabled;
  const arrayItem = typeof topic?.path.at(-1) === 'number';
  document.getElementById('ctxTopicChildLabel').textContent = topic?.child === 'array' ? t('添加数组元素') : t('新增子主题');
  document.getElementById('ctxTopicSiblingLabel').textContent = arrayItem ? t('在下方插入元素') : t('新增同级主题');
  document.getElementById('ctxTopicDeleteLabel').textContent = arrayItem ? t('删除元素') : t('删除分支');
  for(const [id, action] of topicMenuActions){
    document.getElementById(id).disabled = !topic?.[action];
  }
  document.getElementById('ctxEditNode').disabled = !canEditNode(ctxTarget);
  document.getElementById('ctxHideNode').disabled = ctxTarget.dataset.path === '$' || !!activeDoc()?.design;
  document.getElementById('ctxEditNode').title = canEditNode(ctxTarget) ? t('修改当前工作副本中的节点值') : t('索引大文件与字符串内嵌的虚拟节点暂不支持编辑');

  showContextMenu(x, y);
}

function showContextMenu(x, y){
  ctxMenu.style.display = 'block';
  const mw = ctxMenu.offsetWidth;
  const mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';
}

function closeMenu(){
  ctxMenu.style.display = 'none';
}

window.addEventListener('resize', closeMenu);

document.getElementById('ctxHideNode').addEventListener('click', () => {
  const path = ctxTarget?.dataset.path;
  closeMenu();
  const doc = activeDoc();
  if(!path || path === '$' || !doc || doc.design) return;
  (doc.temporaryHiddenRules ??= new Set()).add(normalizePath(path));
  refreshTemplateVisibility();
  showToast(t('已在当前文件临时隐藏。右键画布空白处，打开「管理隐藏规则」即可还原。'));
});

tree.addEventListener('contextmenu', e => {
  const card = e.target.closest('.node-card');
  if(!card) return;
  e.preventDefault();
  e.stopPropagation();

  const node = card.closest('.tree-node');
  if(!node) return;
  ctxTarget = node;
  selectCopyNode(node);
  openMenu(e.clientX, e.clientY);
});

viewport.addEventListener('contextmenu', e => {
  const doc = activeDoc();
  if(!doc || doc.error || ideActive || templateEditing ||
    e.target.closest('.node-card,button,input,textarea,select,a,[contenteditable]')) return;
  e.preventDefault();
  e.stopPropagation();
  ctxTarget = null;
  canvasMenu.hidden = false;
  topicMenu.hidden = true;
  ctxMenu.classList.add('topic-menu');
  document.getElementById('ctxCanvasExpand').textContent = expandAllBtn.textContent;
  document.getElementById('ctxCanvasExpand').disabled = expandAllBtn.disabled;
  document.getElementById('ctxCanvasCollapse').disabled = collapseAllBtn.disabled;
  document.getElementById('ctxCanvasRules').disabled = !!doc.design;
  showContextMenu(e.clientX, e.clientY);
});

for(const [id, action] of [
  ['ctxCanvasExpand', () => expandAllBtn.click()],
  ['ctxCanvasCollapse', () => collapseAllBtn.click()],
  ['ctxCanvasReset', () => resetViewBtn.click()],
  ['ctxCanvasRules', openCanvasRules]
]){
  document.getElementById(id).addEventListener('click', () => {
    closeMenu();
    action();
  });
}

ctxCopyPath.addEventListener('click', async () => {
  const path = ctxTarget?.dataset.path;
  closeMenu();
  if(path) showToast(await copyText(path) ? t('已复制路径') : t('复制失败，请重试'));
});
ctxExpandSubtreeBtn.addEventListener('click', () => {
  if(ctxTarget) expandSubtree(ctxTarget);
  closeMenu();
});
ctxCollapseBtn.addEventListener('click', () => {
  if(ctxTarget) collapseSubtree(ctxTarget);
  closeMenu();
});
document.getElementById('ctxTopicCollapse').addEventListener('click', () => ctxCollapseBtn.click());
for(const [id, action] of topicMenuActions){
  document.getElementById(id).addEventListener('click', () => {
    closeMenu();
    beginTopicEdit(action, ctxTarget);
    if(action === 'delete') viewport.focus({preventScroll:true});
  });
}

/* ---------- 内容弹窗 & 复制 ---------- */
const modalMask = document.getElementById('modalMask');
const modalTitle = document.getElementById('modalTitle');
const modalPath = document.getElementById('modalPath');
const modalBody = document.getElementById('modalBody');
const modalClose = document.getElementById('modalClose');
const modalCopyBtn = document.getElementById('modalCopyBtn');
const ctxViewFull = document.getElementById('ctxViewFull');
const ctxCopy = document.getElementById('ctxCopy');
const toast = document.getElementById('toast');

let toastTimer;
function showToast(msg){
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1600);
}

/* 生成节点的完整内容文本：
   分支节点 → 格式化 JSON；字符串 → 原始文本（不带引号）；其余 → String() */
function nodeContentText(node){
  return node._source.getText(node._sourcePath);
}

/* 写剪贴板：优先 Clipboard API，file:// 等场景回退 execCommand */
async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch(err){
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try{ ok = document.execCommand('copy'); }catch(_){}
    ta.remove();
    return ok;
  }
}

const MODAL_TRUNCATE = 300000; /* 弹窗内渲染上限，复制仍取完整内容 */

let modalGeneration = 0;
async function openModal(node){
  const generation = ++modalGeneration;
  let full;
  try{ full = await nodeContentText(node); }
  catch(error){ if(generation === modalGeneration) showToast(t('读取内容失败：') + error.message); return; }
  if(generation !== modalGeneration || !node.isConnected) return;

  modalTitle.textContent = node._key;
  modalPath.textContent = node.dataset.path;
  modalBody.textContent = full.length > MODAL_TRUNCATE
    ? full.slice(0, MODAL_TRUNCATE) + msg`\n\n…（已显示 ${MODAL_TRUNCATE.toLocaleString()} / ${full.length.toLocaleString()} 个字符；可复制完整内容）`
    : full;
  modalBody._full = full;

  modalMask.classList.add('open');
  modalBody.scrollTop = 0;
}

function closeModal(){
  modalGeneration++;
  modalMask.classList.remove('open');
}

modalClose.addEventListener('click', closeModal);
modalMask.addEventListener('click', e => {
  if(e.target === modalMask) closeModal();
});
modalCopyBtn.addEventListener('click', async () => {
  const ok = await copyText(modalBody._full ?? modalBody.textContent);
  showToast(ok ? t('已复制到剪贴板') : t('复制失败，请手动选择文本复制'));
});

ctxViewFull.addEventListener('click', () => {
  closeMenu();
  if(ctxTarget) openModal(ctxTarget);
});
let copyNodeGeneration = 0;
async function copyNodeContent(node){
  if(!node || node.isConnected === false) return;
  const generation = ++copyNodeGeneration, docId = activeDocId;
  let content;
  try{ content = await nodeContentText(node); }
  catch(error){ showToast(t('读取内容失败：') + error.message); return; }
  if(generation !== copyNodeGeneration || activeDocId !== docId || node.isConnected === false) return;
  const ok = await copyText(content);
  showToast(ok ? t('已复制到剪贴板') : t('复制失败，请手动选择文本复制'));
}
for(const button of [ctxCopy, document.getElementById('ctxTopicCopy')]){
  button.addEventListener('click', () => {
    closeMenu();
    copyNodeContent(ctxTarget);
  });
}

/* ---------- 设置 & 结构模板 ---------- */
const SETTINGS_KEY = 'json-atlas_settings_v1';
const TEMPLATE_KEY = 'json-atlas_template_v1';
const LASTFILE_KEY = 'json-atlas_lastfile_v1';
const DESIGN_DRAFT_PREFIX = 'json-atlas_design-draft_v1:';

function persistDesignDraft(doc, discard = false, notify = showToast){
  if(!doc.design && !doc.draftKey) return;
  const keep = doc.dirty && !discard;
  if(!keep && !doc.draftKey) return;
  try{
    if(keep){
      doc.draftKey ??= DESIGN_DRAFT_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(doc.draftKey, JSON.stringify({
        name:doc.name, text:doc.text, openPaths:doc.openPaths,
        untypedTopics:doc.untypedTopics && [...doc.untypedTopics],
        ideError:doc.ideError || undefined,
        validText:doc.ideError ? JSON.stringify(doc.parsed) : undefined
      }));
    }else{
      localStorage.removeItem(doc.draftKey);
      delete doc.draftKey;
    }
    doc.draftWriteFailed = false;
  }catch(_){
    if(!doc.draftWriteFailed) notify(keep ? t('暂存设计失败，请手动保存') : t('未能清理设计草稿'));
    doc.draftWriteFailed = true;
  }
}

function restoreDesignDrafts(focusDraft = true){
  let restored = 0, latest = null;
  try{
    for(let i = 0; i < localStorage.length; i++){
      const key = localStorage.key(i);
      if(!key?.startsWith(DESIGN_DRAFT_PREFIX)) continue;
      let draft;
      try{ draft = JSON.parse(localStorage.getItem(key)); }catch(_){ continue; }
      if(typeof draft?.name !== 'string' || typeof draft.text !== 'string') continue;
      let doc = docs.find(item => item.design && item.dirty && !item.draftKey && item.name === draft.name && item.text === draft.text);
      if(!doc){
        const size = new Blob([draft.text]).size;
        if(needsIndex(size, settings.largeFileThresholdMiB)) continue;
        const validText = typeof draft.ideError === 'string' ? draft.validText : draft.text;
        if(typeof validText !== 'string') continue;
        doc = buildDoc(validText, draft.name, size);
        if(doc.error || doc.kind !== 'json') continue;
        if(draft.ideError){
          doc.text = doc.ideDraft = draft.text;
          doc.ideError = draft.ideError;
          doc.viewOverride = 'ide';
        }
        docs.push(doc);
      }
      Object.assign(doc, { design:true, temporary:true, dirty:true, draftKey:key,
        untypedTopics:Array.isArray(draft.untypedTopics)
          ? new Set(draft.untypedTopics.filter(path => typeof path === 'string' && path !== '$')) : undefined,
        openPaths:Array.isArray(draft.openPaths) ? draft.openPaths.filter(path => typeof path === 'string') : ['$'] });
      latest = doc;
      restored++;
    }
  }catch(_){ /* Local storage is unavailable. */ }
  if(latest){
    if(focusDraft || (!activeDoc() && !selectedLoad)) activateDoc(latest.id);
    else renderRail();
    showToast(msg`已恢复 ${restored} 份未保存的设计`);
  }
}
/* 阅读会话（展开状态 + 视图位置）单独存一个键：
   它变化频繁，不能每次都把文件原文一起重写 */
const SESSION_KEY = 'json-atlas_session_v1';

/* 旧键一次性接管：项目早期（Hopecat 工具集里的 json_mindmap_reader.html）
   使用 jsonmap_* 前缀。只在新键缺失时把旧值复制过来，随后由正常的保存流程
   写回新键；旧键保留不动，便于回退到网页版。 */
(function adoptLegacyKeys(){
  const pairs = [
    [SETTINGS_KEY, 'jsonmap_settings_v1'],
    [TEMPLATE_KEY, 'jsonmap_template_v1'],
    [LASTFILE_KEY, 'jsonmap_lastfile_v1'],
    [SESSION_KEY,  'jsonmap_session_v1']
  ];
  for(const [next, prev] of pairs){
    try{
      if(localStorage.getItem(next) !== null) continue;
      const legacy = localStorage.getItem(prev);
      if(legacy !== null) localStorage.setItem(next, legacy);
    }catch(_){ /* 隐私模式等场景下 localStorage 不可用，直接跳过 */ }
  }
})();

let settings = {
  theme: 'system',
  viewMode: 'tree',
  ideFoldAlwaysVisible: false,
  nodeSelectionStyle: false,
  vimEditing: false,
  showTopicDock: false,
  topicDoubleClick: 'rename',
  limitIdeComplexity: true,
  designLimitMiB: 8,
  largeFileThresholdMiB: 64,
  indexRebuild: 'smart',
  legacyTreeLayout: false,
  branchLineAction: 'off',
  autoTemplate: true,
  defaultLevels: 0,
  indexBase: 0,              /* 数组索引编号起始值：0 基 / 1 基（仅影响显示） */
  reopenLast: false,
  lowMemoryMode: false,
  idleReleaseMinutes: 0,
  residentFileLimit: 0,
  restoreSession: true,      /* 刷新后恢复上次的阅读位置与展开状态（跟随 reopenLast 生效） */
  jsonlWrapArray: true,
  strictJsonl: false,
  limitValueHeight: false,   /* 限制字段内容的最大高度 */
  valueMaxLines: 6,          /* 最大高度（行） */
  railStyle: 'default',      /* 多文件栏样式：default 贴左侧竖条 / dial 悬浮细线 */
  contextMenu: normalizeContextMenu()
};
let template = null;

try{
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  if(s && typeof s === 'object' && !Array.isArray(s)) {
    for(const key of Object.keys(settings)) {
      if(Object.hasOwn(s, key) && typeof s[key] === typeof settings[key]) settings[key] = s[key];
    }
  }
}catch(_){}
settings.largeFileThresholdMiB = normalizeThreshold(settings.largeFileThresholdMiB);
settings.idleReleaseMinutes = normalizeIdleRelease(settings.idleReleaseMinutes);
settings.residentFileLimit = normalizeResidentLimit(settings.residentFileLimit);
settings.designLimitMiB = normalizeDesignLimit(settings.designLimitMiB);
settings.indexRebuild = settings.indexRebuild === 'always' ? 'always' : 'smart';
settings.viewMode = normalizeViewMode(settings.viewMode);
settings.topicDoubleClick = settings.topicDoubleClick === 'value' ? 'value' : 'rename';
settings.theme = normalizeTheme(settings.theme);
settings.contextMenu = normalizeContextMenu(settings.contextMenu);
settings.branchLineAction = normalizeBranchLineAction(settings.branchLineAction);
const applyTheme = watchTheme(document.documentElement, window.matchMedia?.('(prefers-color-scheme: dark)'), settings.theme,
  (resolved, preference) => updateWindowTheme(preference, resolved));
document.getElementById('optTheme').addEventListener('change', e => {
  settings.theme = normalizeTheme(e.target.value); applyTheme(settings.theme); saveSettings();
});
try{
  const t = JSON.parse(localStorage.getItem(TEMPLATE_KEY));
  template = normalizeTemplateSources(t);
  if(template && t.hiddenSources !== undefined) saveTemplate();
}catch(_){ template = null; }

const languageSelect = document.getElementById('optLanguage');
languageSelect.value = getLanguage();
languageSelect.addEventListener('change', event => {
  const preference = normalizeLanguage(event.target.value);
  if (saveLanguage(preference)) {
    languageSelect.value = preference;
    if (preference !== getLanguage()) showToast(t('语言已保存，重新打开应用或刷新网页后生效。'));
  } else {
    languageSelect.value = getLanguage();
    showToast(t('无法保存语言设置，请检查本地存储权限。'));
  }
});

function saveSettings(){
  try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(_){}
}
function ruleSourceName(source){
  const name = typeof source === 'string' ? source : source?.name;
  return typeof name === 'string' ? name.split(/[\\/]/).at(-1) : '';
}

function normalizeTemplateSources(value){
  if(!Array.isArray(value?.paths)) return null;
  if(value.hiddenSources === undefined) return value;
  const sources = Object.entries(value.hiddenSources || {}).flatMap(([path, source]) => {
    const name = ruleSourceName(source);
    return name ? [[path, {name}]] : [];
  });
  return {...value, hiddenSources:Object.fromEntries(sources)};
}

function saveTemplate(){
  try{ localStorage.setItem(TEMPLATE_KEY, JSON.stringify(template)); }catch(_){}
}

/* prefix 按 JSONPath 段边界判断是否为 path 的严格前缀（避免 $.a 误配 $.ab） */
function isPathPrefix(prefix, path, normalize = true){
  const p = normalize ? normalizePath(prefix) : prefix;
  if(!path.startsWith(p) || path.length <= p.length) return false;

  const next = path[p.length];
  return next === '.' || next === '[';
}

/* 当前文件生效的隐藏规则。传入 null 仅返回全局模板规则。 */
function getHiddenSet(doc = activeDoc()){
  const hidden = new Set(Array.isArray(template?.hidden)
    ? template.hidden.filter(path => typeof path === 'string' && path !== '$' && !doc?.maskedHiddenRules?.has(path))
    : []);
  for(const path of doc?.temporaryHiddenRules || []) hidden.add(path);
  return hidden;
}

function refreshTemplateVisibility(){
  if(!activeDocId) return;
  snapshotDoc();
  activateDoc(activeDocId);
}

function saveHiddenRules(hidden){
  const doc = activeDoc();
  const previous = getHiddenSet(null);
  const name = ruleSourceName(doc?.name);
  const source = name ? {name} : null;
  const hiddenSources = Object.fromEntries([...hidden].map(path => [
    path, previous.has(path) ? template?.hiddenSources?.[path] ?? null : source
  ]));
  for(const item of docs){
    for(const path of item.maskedHiddenRules || []){
      if(!hidden.has(path)) item.maskedHiddenRules.delete(path);
    }
  }
  template = {
    paths: template?.paths || [],
    hidden: [...hidden],
    hiddenSources,
    file: doc?.name || template?.file || '',
    savedAt: Date.now()
  };
  saveTemplate();
  updateTemplateStatus();
  if(!ideActive) refreshTemplateVisibility();
}

/* 记录模板：当前所有处于展开态的节点路径（归一化后） */
function recordTemplate(){
  const root = tree.firstElementChild;
  if(!root){ showToast(t('请先打开文件')); return; }

  const paths = [...tree.querySelectorAll('.tree-node.open')]
    .map(n => normalizePath(n.dataset.path));

  if(!paths.length){ showToast(t('当前全部收起，没有可记录的层级')); return; }

  template = {
    ...template,
    paths,
    /* 结构模板 = 展开层级 + 隐藏字段：这里只改展开层级，保留已有的隐藏配置 */
    hidden: (template && template.hidden) || [],
    file: fileName.textContent || '',
    savedAt: Date.now()
  };
  saveTemplate();
  updateTemplateStatus();
  showToast(msg`模板已记录：${paths.length} 个展开节点`);
}

/* 展开节点：数组只走第一项，对象走全部子节点 */
function childNodesToVisit(node, firstArrayOnly = true){
  const c = directChildrenContainer(node);
  if(!c) return [];
  const kids = [...c.children].filter(n => n.classList.contains('tree-node'));
  /* 字符串型 JSON 节点：按解析出来的值判断是否为数组 */
  return firstArrayOnly && node._childrenType === 'array' ? kids.slice(0, 1) : kids;
}

/* 精确会话路径还记录父节点应加载的子项，以便恢复非首页的数组项。
   按路径段匹配，避免把带点号、括号或数字的对象键误当作数组下标。 */
function sessionChildKeys(paths){
  const result = new Map();
  for(const path of paths){
    if(typeof path !== 'string' || !path.startsWith('$')) continue;
    let prefix = '$';
    for(const match of path.matchAll(/\.[A-Za-z_$][\w$]*|\[(?:\d+|"(?:\\.|[^"\\])*")\]/g)){
      if(match.index !== prefix.length) break;
      const segment = match[0];
      const key = segment[0] === '.' ? segment.slice(1) : JSON.parse(segment.slice(1, -1));
      if(!result.has(prefix)) result.set(prefix, key);
      prefix += segment;
    }
  }
  return result;
}

/* 模板按归一化路径、数组首项恢复；会话按精确路径恢复实际展开项。 */
async function expandByPaths(paths, { exact = false, pageOffsets } = {}){
  const generation = expansionGeneration;
  const root = tree.firstElementChild;
  const set = new Set(paths || []);
  if(!root || !set.size) return null;

  const pathList = [...set];
  const childKeys = exact ? sessionChildKeys(pathList) : null;
  let deepest = null;
  let deepestLen = -1;

  const pending = [root];
  while(pending.length){
    if(generation !== expansionGeneration) return null;
    const node = pending.pop();
    if(tree.querySelectorAll('.tree-node').length >= 5000){
      showNodeLimit(tree, t('已达到 5000 个显示节点，停止恢复展开')); break;
    }
    if(!node.classList.contains('branch')){
      /* 字符串型 JSON 字段：命中它下级的路径时先按 JSON 展开，
         否则记录在它内部的结构会整体落空 */
      if(node._jsonSource &&
         pathList.some(p => isPathPrefix(node.dataset.path, p, !exact))){
        buildJsonChildren(node);
      }else{
        continue;
      }
    }
    if(!set.has(exact ? node.dataset.path : normalizePath(node.dataset.path))) continue;

    await expandOne(node, childKeys?.get(node.dataset.path), exact ? pageOffsets?.[node.dataset.path] : undefined);
    if(generation !== expansionGeneration) return null;

    const p = node.dataset.path;
    if(p.length > deepestLen){ deepestLen = p.length; deepest = node; }

    pending.push(...childNodesToVisit(node, !exact).reverse());
  }

  return deepest;
}

/* 应用模板：展开所有命中的层级，返回最深的展开节点用于定位 */
function applyTemplate(){
  if(!template || !template.paths.length) return null;
  return expandByPaths(template.paths);
}

/* 按固定层数展开（无模板时的默认策略），数组同样只展开第一项 */
async function expandLevels(node, levels){
  const generation = expansionGeneration;
  const pending = [{ node, remain: levels }];
  while(pending.length){
    if(generation !== expansionGeneration) return;
    const { node: n, remain } = pending.pop();
    if(!n || !n.classList.contains('branch') || remain <= 0) continue;
    if(tree.querySelectorAll('.tree-node').length >= 5000){
      showNodeLimit(tree, t('已达到 5000 个显示节点，停止默认展开')); break;
    }
    await expandOne(n);
    if(generation !== expansionGeneration) return;
    pending.push(...childNodesToVisit(n).reverse().map(child => ({ node: child, remain: remain - 1 })));
  }
  updateVirtualization();
}

/* ---------- 设置面板 ---------- */
const settingsMask = document.getElementById('settingsMask');
const settingsClose = document.getElementById('settingsClose');
const settingsBtn = document.getElementById('settingsBtn');
const optAutoTemplate = document.getElementById('optAutoTemplate');
const optDefaultLevels = document.getElementById('optDefaultLevels');
const optIndexBase = document.getElementById('optIndexBase');
const optRailStyle = document.getElementById('optRailStyle');
const optBranchLineAction = document.getElementById('optBranchLineAction');
const optLegacyTreeLayout = document.getElementById('optLegacyTreeLayout');
const optLargeFileThreshold = document.getElementById('optLargeFileThreshold');
const optDesignLimit = document.getElementById('optDesignLimit');
const optIndexRebuild = document.getElementById('optIndexRebuild');
function syncThresholdControl(){
  optLargeFileThreshold.value = String(settings.largeFileThresholdMiB);
  optDesignLimit.value = String(settings.designLimitMiB);
  optIndexRebuild.value = settings.indexRebuild;
  document.getElementById('optViewMode').value = settings.viewMode;
  document.getElementById('optIdeFoldAlwaysVisible').checked = settings.ideFoldAlwaysVisible;
  document.getElementById('optNodeSelectionStyle').checked = settings.nodeSelectionStyle;
  document.getElementById('optLimitIdeComplexity').checked = settings.limitIdeComplexity;
}
document.getElementById('optLimitIdeComplexity').addEventListener('change', e => {
  if(!leaveIde()){ syncThresholdControl(); return; }
  changeReadingSetting('limitIdeComplexity', e.target.checked);
});
optLargeFileThreshold.addEventListener('change', () => {
  if(!leaveIde()){ syncThresholdControl(); return; }
  changeReadingSetting('largeFileThresholdMiB', normalizeThreshold(optLargeFileThreshold.value));
  syncThresholdControl();
});
optDesignLimit.addEventListener('change', () => {
  changeReadingSetting('designLimitMiB', normalizeDesignLimit(optDesignLimit.value));
  syncThresholdControl();
});
optIndexRebuild.addEventListener('change', () => {
  changeReadingSetting('indexRebuild', optIndexRebuild.value === 'always' ? 'always' : 'smart');
});
const optReopenLast = document.getElementById('optReopenLast');
const optLowMemoryMode = document.getElementById('optLowMemoryMode');
const optIdleRelease = document.getElementById('optIdleRelease');
const optResidentFileLimit = document.getElementById('optResidentFileLimit');
const releaseBackgroundFiles = document.getElementById('releaseBackgroundFiles');
const optRestoreSession = document.getElementById('optRestoreSession');
const exportSettingsBtn = document.getElementById('exportSettingsBtn');
const importSettingsBtn = document.getElementById('importSettingsBtn');
const settingsImportInput = document.getElementById('settingsImportInput');
const templateStatus = document.getElementById('templateStatus');
const applyTemplateBtn = document.getElementById('applyTemplateBtn');
const clearTemplateBtn = document.getElementById('clearTemplateBtn');
const recordTemplateBtn = document.getElementById('recordTemplateBtn');
const recordTemplateBtn2 = document.getElementById('recordTemplateBtn2');

const openHiddenRuleGroups = new Set();
const hiddenTemplateSearch = document.getElementById('hiddenTemplateSearch');
const canvasRulesDialog = document.getElementById('canvasRulesDialog');
let canvasRulesDoc = null, canvasRulesScan = null;

function makeRuleButton(text, label, handler){
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', handler);
  return button;
}

function makeRuleMask(doc, path){
  const mask = makeRuleButton(t('屏蔽'), msg`屏蔽规则 ${path}`, () => {
    if(!doc || activeDoc() !== doc) return;
    const masked = doc.maskedHiddenRules ??= new Set();
    if(masked.has(path)) masked.delete(path);
    else masked.add(path);
    updateMask();
    if(!ideActive) refreshTemplateVisibility();
  });
  const updateMask = () => {
    const masked = doc?.maskedHiddenRules?.has(path) === true;
    mask.textContent = masked ? t('取消屏蔽') : t('屏蔽');
    mask.dataset.masked = String(masked);
    mask.setAttribute('aria-label', msg`${mask.textContent}规则 ${path}`);
  };
  mask.disabled = !doc || !!doc.design;
  mask.title = t('仅对当前活动文件有效');
  updateMask();
  return mask;
}

async function findMatchingHiddenRules(source, rules, signal){
  const root = {children:new Map()};
  const matches = new Set();
  for(const rule of rules){
    const parts = [...rule.matchAll(/\.([A-Za-z_$][\w$]*)|\[(0|"(?:\\.|[^"\\])*")\]/g)];
    let keys;
    try { keys = parts.map(part => part[1] ?? JSON.parse(part[2])); }
    catch { continue; }
    if(!keys.length || encodePath(keys) !== rule) continue;
    let branch = root;
    for(const key of keys){
      if(!branch.children.has(key)) branch.children.set(key, {children:new Map()});
      branch = branch.children.get(key);
    }
    branch.rule = rule;
  }

  let pages = 0;
  async function visit(dataSource, node, branch){
    signal.throwIfAborted();
    if(branch.rule){
      matches.add(branch.rule);
      delete branch.rule;
    }
    if(!branch.children.size) return;

    if(node.type === 'string' && !node.truncated){
      const value = parseJsonInString(node.value);
      if(value === undefined) return;
      const embedded = new MemoryDataSource(value);
      try { await visit(embedded, embedded.getRoot(), branch); }
      finally { embedded.dispose(); }
      return;
    }
    if(node.type !== 'array' && node.type !== 'object') return;

    // A normalized array step applies to every element. Object keys are unique
    // in the reader, so each relevant key only needs one lookup per object.
    const remaining = new Set([...branch.children.keys()].filter(key => node.type === 'array' ? key === 0 : typeof key === 'string'));
    for(let offset = 0; remaining.size && offset < node.childCount;){
      const page = await dataSource.getChildren(node.path, {offset, signal, cache:false});
      signal.throwIfAborted();
      for(const item of page.items){
        const key = item.arrayItem ? 0 : item.key;
        if(!remaining.has(key)) continue;
        const child = branch.children.get(key);
        await visit(dataSource, item, child);
        if(!child.rule && !child.children.size){
          branch.children.delete(key);
          remaining.delete(key);
        } else if(node.type === 'object') remaining.delete(key);
        if(!remaining.size) break;
      }
      if(page.end <= offset) break;
      offset = page.end;
      if(++pages % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if(root.children.size) await visit(source, source.getRoot(), root);
  return [...rules].filter(rule => matches.has(rule));
}

async function openCanvasRules(){
  const doc = activeDoc();
  if(!doc?.source || doc.design || doc.error || ideActive || canvasRulesDialog.open) return;
  canvasRulesDoc = doc;
  const scan = new AbortController();
  canvasRulesScan?.abort();
  canvasRulesScan = scan;
  const list = document.getElementById('canvasRulesList');
  const status = document.getElementById('canvasRulesEmpty');
  const group = document.getElementById('canvasRulesGroup');
  const updateRulesStatus = () => {
    group.hidden = !list.firstElementChild;
    status.hidden = !group.hidden;
    status.textContent = t('当前文件没有匹配的隐藏规则。');
  };
  list.replaceChildren();
  status.hidden = false;
  status.textContent = t('正在匹配当前文件中的规则…');
  document.getElementById('canvasRulesFile').textContent = doc.name;
  for(const path of doc.temporaryHiddenRules || []){
    const row = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = path;
    const restore = makeRuleButton(t('还原临时隐藏'), msg`还原临时隐藏规则 ${path}`, () => {
      if(scan.signal.aborted || !canvasRulesDialog.open || activeDoc() !== doc) return;
      doc.temporaryHiddenRules.delete(path);
      row.remove();
      if(!status.hidden) group.hidden = !list.firstElementChild;
      else updateRulesStatus();
      (list.firstElementChild?.children[1] || document.getElementById('canvasRulesClose')).focus();
      refreshTemplateVisibility();
    });
    row.append(code, restore);
    list.appendChild(row);
  }
  group.hidden = !list.firstElementChild;
  canvasRulesDialog.showModal();

  try{
    const templateRules = getHiddenSet(null);
    const rules = templateRules.size ? await findMatchingHiddenRules(doc.source, templateRules, scan.signal) : [];
    if(scan.signal.aborted || !canvasRulesDialog.open || activeDoc() !== doc) return;
    for(const path of rules){
      const row = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = path;
      row.append(code, makeRuleMask(doc, path));
      list.appendChild(row);
    }
    updateRulesStatus();
  }catch(error){
    if(!scan.signal.aborted && canvasRulesDialog.open && activeDoc() === doc){
      status.textContent = t('无法检查当前文件的隐藏规则：') + error.message;
    }
  }
}

document.getElementById('canvasRulesClose').addEventListener('click', () => canvasRulesDialog.close());
canvasRulesDialog.addEventListener('close', () => {
  if(canvasRulesDialog.open) return;
  canvasRulesScan?.abort();
  canvasRulesScan = null;
  canvasRulesDoc = null;
});

function renderHiddenRules(hidden){
  const list = document.getElementById('hiddenTemplateList');
  document.getElementById('hiddenTemplateRules').hidden = !hidden.size;
  list.replaceChildren();
  const query = hiddenTemplateSearch.value.trim().toLowerCase();
  const groups = new Map();
  for(const path of hidden){
    const key = ruleSourceName(template?.hiddenSources?.[path]) || null;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path);
  }
  for(const key of openHiddenRuleGroups){
    if(!groups.has(key)) openHiddenRuleGroups.delete(key);
  }
  const doc = activeDoc();
  for(const [key, paths] of groups){
    const name = key ?? t('来源未知');
    const matches = name.toLowerCase().includes(query)
      ? paths : paths.filter(path => path.toLowerCase().includes(query));
    if(!matches.length) continue;
    const group = document.createElement('li');
    group.className = 'hidden-rule-group';
    const details = document.createElement('details');
    details.open = !!query || openHiddenRuleGroups.has(key);
    details.addEventListener('toggle', () => {
      if(query || details.isConnected === false) return;
      if(details.open) openHiddenRuleGroups.add(key);
      else openHiddenRuleGroups.delete(key);
    });
    const summary = document.createElement('summary');
    const fileName = document.createElement('span');
    fileName.className = 'hidden-rule-file';
    fileName.textContent = name;
    const count = document.createElement('span');
    count.className = 'hidden-rule-count';
    count.textContent = String(paths.length);
    summary.setAttribute('aria-label', msg`${name}，${paths.length} 条规则`);
    summary.title = name;
    summary.append(fileName, count);
    const rows = document.createElement('ul');
    for(const path of matches){
      const row = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = path;
      const remove = makeRuleButton(t('删除'), msg`删除规则 ${path}`, () => {
        const rules = getHiddenSet(null);
        rules.delete(path);
        saveHiddenRules(rules);
        document.getElementById('settingsNav3').focus();
      });
      remove.className = 'hidden-rule-delete';
      row.append(code, remove, makeRuleMask(doc, path));
      rows.appendChild(row);
    }
    const removeGroup = makeRuleButton(t('删除该组'), msg`删除 ${name} 创建的规则`, () => {
      const rules = getHiddenSet(null);
      for(const path of paths) rules.delete(path);
      saveHiddenRules(rules);
      document.getElementById('settingsNav3').focus();
    });
    removeGroup.title = t('删除此文件名下的全部规则');
    removeGroup.className = 'hidden-rule-delete hidden-rule-delete-group';
    details.append(summary, rows);
    group.append(details, removeGroup);
    list.appendChild(group);
  }
  document.getElementById('hiddenTemplateEmpty').hidden = !hidden.size || !!list.firstElementChild;
}

hiddenTemplateSearch.addEventListener('input', () => renderHiddenRules(getHiddenSet(null)));

function updateTemplateStatus(){
  const hidden = getHiddenSet(null);
  renderHiddenRules(hidden);
  if(template && (template.paths.length || hidden.size)){
    const d = new Date(template.savedAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const hiddenPart = hidden.size ? msg` · ${hidden.size} 条隐藏规则` : '';
    templateStatus.textContent =
      msg`已记录 ${template.paths.length} 个节点${hiddenPart} · ${template.file || t('未知文件')} · ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    applyTemplateBtn.disabled = !template.paths.length;
    clearTemplateBtn.disabled = false;
  }else{
    templateStatus.textContent = t('未记录');
    applyTemplateBtn.disabled = true;
    clearTemplateBtn.disabled = true;
  }
}

function applyContextMenuSettings(){
  const buttons = new Map(contextMenuItems.map(({id, button}) => [id, button]));
  ctxMenu.replaceChildren(canvasMenu, topicMenu, ...settings.contextMenu.map(({id, enabled}) => {
    const button = buttons.get(id);
    button.hidden = !enabled;
    return button;
  }));
}

function renderContextMenuSettings(focusedItem, direction){
  const list = document.getElementById('contextMenuOptions');
  list.replaceChildren();
  let nextFocus;
  settings.contextMenu.forEach((item, index) => {
    const {label} = contextMenuItems.find(candidate => candidate.id === item.id);
    const row = document.createElement('li');
    const labelEl = document.createElement('label');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = item.enabled;
    enabled.addEventListener('change', () => {
      item.enabled = enabled.checked;
      applyContextMenuSettings();
      saveSettings();
    });
    labelEl.append(enabled, document.createTextNode(label));
    row.appendChild(labelEl);
    for(const step of [-1, 1]){
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'tf-btn';
      move.textContent = step < 0 ? '↑' : '↓';
      move.setAttribute('aria-label', `${step < 0 ? t('上移') : t('下移')}${label}`);
      const destination = index + step;
      move.disabled = destination < 0 || destination >= settings.contextMenu.length;
      move.addEventListener('click', () => {
        settings.contextMenu.splice(index, 1);
        settings.contextMenu.splice(destination, 0, item);
        applyContextMenuSettings();
        saveSettings();
        renderContextMenuSettings(item.id, step);
      });
      row.appendChild(move);
      if(focusedItem === item.id && direction === step) nextFocus = move.disabled ? enabled : move;
    }
    list.appendChild(row);
  });
  nextFocus?.focus();
}

document.getElementById('resetContextMenu').addEventListener('click', () => {
  settings.contextMenu = normalizeContextMenu();
  applyContextMenuSettings();
  renderContextMenuSettings();
  saveSettings();
});
applyContextMenuSettings();

const settingsPages = [0, 1, 2, 6, 3, 4, 5];
const settingsNavLayout = window.matchMedia?.('(max-width: 700px)');
function updateSettingsNavOrientation(){
  document.getElementById('settingsNav').setAttribute('aria-orientation', settingsNavLayout?.matches ? 'horizontal' : 'vertical');
}
settingsNavLayout?.addEventListener('change', updateSettingsNavOrientation);
updateSettingsNavOrientation();
let settingsPage = 0;
let memoryStatsTimer;

function refreshMemoryStats(){
  clearTimeout(memoryStatsTimer);
  if(settingsPage !== 6 || !settingsMask.classList.contains('open')) return;
  const resident = docs.filter(doc => !doc.unloaded).length;
  const released = docs.filter(doc => doc.unloaded === 'idle').length;
  const deferred = docs.length - resident - released;
  const indexed = docs.filter(doc => doc.source?.indexed).length;
  const cache = sharedPageCache.stats;
  const queue = fileLoads.length ? msg` · 读取队列 ${fileLoads.length} 个` : '';
  document.getElementById('residentFileStatus').textContent =
    msg`已载入 ${resident} 个 · 待载入 ${deferred} 个 · 已释放 ${released} 个${queue}`;
  document.getElementById('indexCacheStatus').textContent =
    msg`索引文件 ${indexed} 个 · ${cache.entries ? msg`已缓存 ${cache.entries} 页（约 ${formatBytes(cache.bytes)}）` : t('暂无缓存页')} · 预算 ${formatBytes(cache.budget)}`
    + (indexed && !cache.entries ? t('。展开节点时按需读取子页。') : '');
  releaseBackgroundFiles.disabled = !docs.some(canReleaseDocument);
  memoryStatsTimer = setTimeout(refreshMemoryStats, 1000);
}

releaseBackgroundFiles.addEventListener('click', () => {
  const candidates = docs.filter(canReleaseDocument);
  if(!candidates.length) return;
  candidates.forEach(releaseDocument);
  scheduleMemoryRelease();
  renderRail();
  showToast(msg`已释放 ${candidates.length} 个后台文件`);
});

function showSettingsPage(index, focus = false){
  settingsPage = index;
  for(const i of settingsPages){
    const button = document.getElementById(`settingsNav${i}`);
    button.setAttribute('aria-selected', String(i === settingsPage));
    button.tabIndex = i === settingsPage ? 0 : -1;
    document.getElementById(`settingsPage${i}`).hidden = i !== settingsPage;
    if(i === settingsPage && focus) button.focus();
  }
  document.getElementById('settingsContent').scrollTop = 0;
  document.getElementById('recordTemplateBtn2').hidden = settingsPage !== 3;
  document.getElementById('settingsFooter').hidden = settingsPage !== 3;
  refreshMemoryStats();
}
for(const i of settingsPages){
  const button = document.getElementById(`settingsNav${i}`);
  button.addEventListener('click', () => showSettingsPage(i));
  button.addEventListener('keydown', e => {
    const horizontal = settingsNavLayout?.matches;
    const index = settingsPages.indexOf(i), count = settingsPages.length;
    const next = e.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? (index + 1) % count
      : e.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? (index + count - 1) % count
      : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : null;
    if(next === null) return;
    e.preventDefault(); showSettingsPage(settingsPages[next], true);
  });
}
function openSettings(){
  showSettingsPage(settingsPage);
  document.getElementById('optTheme').value = settings.theme;
  document.getElementById('optVimEditing').checked = settings.vimEditing === true;
  document.getElementById('optTopicDock').checked = settings.showTopicDock === true;
  document.getElementById('optTopicDoubleClick').value = settings.topicDoubleClick;
  syncThresholdControl();
  optLegacyTreeLayout.checked = settings.legacyTreeLayout === true;
  optBranchLineAction.value = settings.branchLineAction;
  optAutoTemplate.checked = settings.autoTemplate;
  optDefaultLevels.value = String(settings.defaultLevels);
  optIndexBase.value = settings.indexBase === 1 ? '1' : '0';
  optRailStyle.value = settings.railStyle === 'dial' ? 'dial' : 'default';
  optReopenLast.checked = settings.reopenLast;
  optLowMemoryMode.checked = settings.lowMemoryMode;
  optIdleRelease.value = String(settings.idleReleaseMinutes);
  optResidentFileLimit.value = String(settings.residentFileLimit);
  optSettingsJsonlArray.checked = settings.jsonlWrapArray !== false;
  optStrictJsonl.checked = !!settings.strictJsonl;
  optLimitValueHeight.checked = !!settings.limitValueHeight;
  optValueMaxLines.value = String(settings.valueMaxLines || 6);
  optRestoreSession.checked = !!settings.restoreSession;
  syncValueHeightControls();
  syncReopenControls();
  updateTemplateStatus();
  renderContextMenuSettings();
  settingsMask.classList.add('open');
  refreshMemoryStats();
}
function closeSettings(){
  settingsMask.classList.remove('open');
  refreshMemoryStats();
  flushReadingSettings();
}

// Persist the switches as they change, but use the final values for work on the document.
let previousReadingSettings = null, applyingReadingSettings = false, settingsImported = false;
function changeReadingSetting(key, value){
  if(settings[key] === value) return;
  previousReadingSettings ??= {...settings};
  settings[key] = value;
  saveSettings();
  flushReadingSettings();
}

function flushReadingSettings(){
  if(!previousReadingSettings || applyingReadingSettings || settingsMask.classList.contains('open')) return;
  const previous = previousReadingSettings;
  const imported = settingsImported;
  previousReadingSettings = null;
  settingsImported = false;
  const changed = key => previous[key] !== settings[key];
  const doc = activeDoc();
  if(imported || changed('viewMode')) for(const item of docs) delete item.viewOverride;

  const viewChanged = changed('viewMode') || changed('limitIdeComplexity') || changed('largeFileThresholdMiB');
  const view = doc && viewChanged ? documentViewState(doc, false) : null;
  const jsonlChanged = doc?.kind === 'jsonl' && (imported || changed('jsonlWrapArray') || changed('strictJsonl'));
  const designLimitChanged = changed('designLimitMiB');
  const rebuild = !!doc && (imported || jsonlChanged || (view && view.active !== ideActive) ||
    (designLimitChanged && doc.design && !canDesign(doc)));
  if(rebuild && (imported || view)) doc.ideDraft = undefined;

  let pending;
  if(jsonlChanged && doc.source?.indexed && doc.source.wrap !== settings.jsonlWrapArray){
    pending = rebuildJsonlRoot();
  }else if(rebuild){
    snapshotDoc(); activateDoc(doc.id);
  }else if(view){
    syncDocumentView(doc, view, false);
  }
  if(designLimitChanged) syncEditing();
  if(changed('residentFileLimit') && enforceResidentLimit()) renderRail();
  if(changed('idleReleaseMinutes') || changed('residentFileLimit')) scheduleMemoryRelease();

  const measureValues = changed('limitValueHeight') || (settings.limitValueHeight && changed('valueMaxLines'));
  if(changed('legacyTreeLayout')) applyTreeLayout(!measureValues);
  if(changed('branchLineAction')) applyBranchLineAction();
  if(measureValues) applyValueHeightSetting();
  if(changed('indexBase')){
    if(!rebuild) relabelArrayIndexes(tree);
    relabelArrayIndexes(editorTree);
  }
  if(imported || changed('reopenLast')){
    if(!settings.reopenLast){
      try{ localStorage.removeItem(LASTFILE_KEY); }catch(_){}
    }else if(!rebuild) saveReopenCopy();
  }
  if(imported || changed('reopenLast') || changed('restoreSession')){
    if(settings.reopenLast && settings.restoreSession) scheduleSessionSave();
    else{
      try{ localStorage.removeItem(SESSION_KEY); }catch(_){}
    }
  }

  if(pending){
    applyingReadingSettings = true;
    pending.finally(() => {
      applyingReadingSettings = false;
      flushReadingSettings();
    });
  }
}

settingsBtn.addEventListener('click', openSettings);
document.getElementById('landingSettingsBtn').addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsMask.addEventListener('click', e => {
  if(e.target === settingsMask) closeSettings();
});

optAutoTemplate.addEventListener('change', () => {
  settings.autoTemplate = optAutoTemplate.checked;
  saveSettings();
});
optDefaultLevels.addEventListener('change', () => {
  settings.defaultLevels = parseInt(optDefaultLevels.value, 10) || 0;
  saveSettings();
});

/* 索引编号只改显示：就地更新数组元素的标签与搜索文本，不重建树，
   阅读位置与展开层级完全不受影响（JSONPath / 模板 / 会话都用真实下标） */
function relabelArrayIndexes(root){
  if(!root) return;
  root.querySelectorAll('.tree-node').forEach(node => {
    if(!node._isArrayItem || !node._path) return;
    const label = arrayIndexLabel(node._path[node._path.length - 1]);
    node._key = label;
    node.dataset.searchText =
      `${label} ${node._searchValue ?? ''}`.toLowerCase();
    if(node._keyEl) node._keyEl.textContent = label;
  });
}

optIndexBase.addEventListener('change', () => {
  changeReadingSetting('indexBase', parseInt(optIndexBase.value, 10) === 1 ? 1 : 0);
});

/* 多文件栏样式：只切一个类，CSS 负责两套外观，文件列表本身不重建
   （renderRail 每次渲染时会再同步一次，避免样式与设置脱节） */
function applyRailStyle(){
  fileRail.classList.toggle('rail-dial', settings.railStyle === 'dial');
  fileRail.tabIndex = settings.railStyle === 'dial' ? -1 : 0;
  syncRailDialOverflow();
}

function applyTreeLayout(measure = true){
  for(const id of ['tree', 'editorTree']){
    document.getElementById(id).classList.toggle('legacy-tree-layout', settings.legacyTreeLayout === true);
  }
  if(measure){
    viewportWindow.restoreAll();
    if(settings.limitValueHeight) requestAnimationFrame(() => refreshValueOverflow(tree, true));
  }
}

document.getElementById('optNodeSelectionStyle').addEventListener('change', e => {
  settings.nodeSelectionStyle = e.target.checked; applyNodeSelectionStyle(); saveSettings();
});
function applyNodeSelectionStyle(){
  tree.classList.toggle('show-node-selection', settings.nodeSelectionStyle === true);
}
function applyIdeFoldVisibility(){
  document.getElementById('ideView').classList.toggle('ide-fold-always-visible', settings.ideFoldAlwaysVisible === true);
}
document.getElementById('optIdeFoldAlwaysVisible').addEventListener('change', e => {
  settings.ideFoldAlwaysVisible = e.target.checked;
  applyIdeFoldVisibility(); saveSettings();
});

function normalizeBranchLineAction(value){
  return value === 'jump' || value === 'collapse' ? value : 'off';
}
function applyBranchLineAction(){
  tree.classList.toggle('branch-lines-interactive', settings.branchLineAction !== 'off');
}
optBranchLineAction.addEventListener('change', () => {
  changeReadingSetting('branchLineAction', normalizeBranchLineAction(optBranchLineAction.value));
});
optLegacyTreeLayout.addEventListener('change', () => {
  changeReadingSetting('legacyTreeLayout', optLegacyTreeLayout.checked);
});

optRailStyle.addEventListener('change', () => {
  settings.railStyle = optRailStyle.value === 'dial' ? 'dial' : 'default';
  saveSettings();
  applyRailStyle();
  showToast(settings.railStyle === 'dial'
    ? t('多文件栏已切换为悬浮细线')
    : t('多文件栏已切换为默认竖条'));
});

/* 会话恢复依附于「刷新后继续打开」：上级关掉时联动项不可用 */
function syncReopenControls(){
  optRestoreSession.disabled = !settings.reopenLast;
  optLowMemoryMode.disabled = !settings.reopenLast;
}

optReopenLast.addEventListener('change', () => {
  changeReadingSetting('reopenLast', optReopenLast.checked);
  syncReopenControls();
});

optLowMemoryMode.addEventListener('change', () => {
  changeReadingSetting('lowMemoryMode', optLowMemoryMode.checked);
});
optResidentFileLimit.addEventListener('change', () => {
  changeReadingSetting('residentFileLimit', normalizeResidentLimit(optResidentFileLimit.value));
});
optIdleRelease.addEventListener('change', () => {
  changeReadingSetting('idleReleaseMinutes', normalizeIdleRelease(optIdleRelease.value));
});
optRestoreSession.addEventListener('change', () => {
  changeReadingSetting('restoreSession', optRestoreSession.checked);
});

/* JSONL 设置：根结构 + 坏行策略。
   关闭设置后用已有数据更新当前 JSONL，无需重开文件。 */
const optSettingsJsonlArray = document.getElementById('optSettingsJsonlArray');
const optStrictJsonl = document.getElementById('optStrictJsonl');

optSettingsJsonlArray.addEventListener('change', () => {
  if(!leaveIde()){ optSettingsJsonlArray.checked = settings.jsonlWrapArray; return; }
  changeReadingSetting('jsonlWrapArray', optSettingsJsonlArray.checked);
});

optStrictJsonl.addEventListener('change', () => {
  if(!leaveIde()){ optStrictJsonl.checked = settings.strictJsonl; return; }
  changeReadingSetting('strictJsonl', optStrictJsonl.checked);
});

/* ---------- 限制字段内容的最大高度 ----------
   打开时给树加 .limit-value（CSS 负责截断），再由 refreshValueOverflow
   逐个量高度，只有真正溢出的卡片才挂右上角 … 图标 */
const optLimitValueHeight = document.getElementById('optLimitValueHeight');
const optValueMaxLines = document.getElementById('optValueMaxLines');

function syncValueHeightControls(){
  optValueMaxLines.disabled = !settings.limitValueHeight;
}

function applyValueHeightSetting(){
  viewportWindow.restoreAll();
  const on = !!settings.limitValueHeight;

  syncValueHeightControls();
  tree.classList.toggle('limit-value', on);
  tree.style.setProperty('--value-max-lines', String(settings.valueMaxLines || 6));

  if(on){
    refreshValueOverflow(tree, true);
    return;
  }

  /* 关闭时把所有 … 图标收回去，DOM 保持干净 */
  tree.querySelectorAll('.node-card.has-fullview').forEach(card => {
    if(card._previewTruncated) return;
    card.classList.remove('has-fullview');
    card.querySelector(':scope > .card-icons > .fullview-badge')?.remove();
    dropEmptyCardIcons(card);
  });
}

optLimitValueHeight.addEventListener('change', () => {
  changeReadingSetting('limitValueHeight', optLimitValueHeight.checked);
  syncValueHeightControls();
});

optValueMaxLines.addEventListener('change', () => {
  changeReadingSetting('valueMaxLines', parseInt(optValueMaxLines.value, 10) || 6);
});

/* 窗口变窄会让值换行更多：全部重测一次（防抖） */
let overflowResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(overflowResizeTimer);
  overflowResizeTimer = setTimeout(() => {
    viewportWindow.restoreAll();
    if(settings.limitValueHeight) refreshValueOverflow(tree, true);
  }, 200);
});

/* 按当前 settings 重建当前文档的根结构（不重新读盘）。
   仅当当前文档是 JSONL 时生效。 */
let jsonlConfigurationGeneration = 0;
async function rebuildJsonlRoot(){
  const doc = activeDoc();
  if(!doc || doc.kind !== 'jsonl') return;

  snapshotDoc();
  if(doc.source?.indexed){
    const generation = ++jsonlConfigurationGeneration;
    try {
      await doc.source.configure(settings.jsonlWrapArray !== false, false);
      if(generation !== jsonlConfigurationGeneration || activeDocId !== doc.id || doc.source.wrap !== settings.jsonlWrapArray) return;
    } catch(error) { showToast(t('更新失败：') + (error.message || String(error))); return; }
  }
  activateDoc(doc.id);
}

/* ---------- 设置导入 / 导出 ---------- */
exportSettingsBtn.addEventListener('click', async () => {
  if(exportSettingsBtn.disabled) return;
  const payload = {
    app: 'json-atlas',
    appName: 'JSON Atlas',
    appVersion: manifest.version,
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    template: normalizeTemplateSources(template)
  };
  const name = 'json-atlas-settings.json';
  const text = JSON.stringify(payload, null, 2);
  if(desktop){
    exportSettingsBtn.disabled = true;
    try{
      const path = await saveDocumentCopy(name, text, null, docs.map(doc => doc.path).filter(Boolean));
      if(path) showToast(t('设置已导出'));
    }catch(error){
      showToast(t('导出设置失败：') + (error.message || String(error)));
    }finally{
      exportSettingsBtn.disabled = false;
    }
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  showToast(t('设置已导出'));
});

importSettingsBtn.addEventListener('click', () => settingsImportInput.click());

settingsImportInput.addEventListener('change', () => {
  const file = settingsImportInput.files[0];
  settingsImportInput.value = '';
  if(!file || importSettingsBtn.disabled) return;
  if(!leaveIde()) return;

  const reader = new FileReader();
  importSettingsBtn.disabled = true;
  reader.onloadend = () => { importSettingsBtn.disabled = false; };
  reader.onload = () => {
    try{
      const payload = JSON.parse(reader.result);
      if(!payload || typeof payload !== 'object') throw new Error(t('文件格式不正确'));
      if(!leaveIde()) return;
      /* 兼容两种格式：完整导出包 { settings, template } 或裸设置对象 */
      const s = (payload.settings && typeof payload.settings === 'object')
        ? payload.settings : payload;

      previousReadingSettings ??= {...settings};
      settingsImported = true;
      settings = {
        theme: normalizeTheme(s.theme),
        viewMode: normalizeViewMode(s.viewMode),
        ideFoldAlwaysVisible: s.ideFoldAlwaysVisible === true,
        nodeSelectionStyle: s.nodeSelectionStyle === true,
        vimEditing: s.vimEditing === true,
        showTopicDock: s.showTopicDock === true,
        topicDoubleClick: s.topicDoubleClick === 'value' ? 'value' : 'rename',
        limitIdeComplexity: s.limitIdeComplexity !== false,
        designLimitMiB: normalizeDesignLimit(s.designLimitMiB),
        largeFileThresholdMiB: normalizeThreshold(s.largeFileThresholdMiB),
        indexRebuild: s.indexRebuild === 'always' ? 'always' : 'smart',
        legacyTreeLayout: s.legacyTreeLayout === true,
        branchLineAction: normalizeBranchLineAction(s.branchLineAction),
        autoTemplate: !!s.autoTemplate,
        defaultLevels: parseInt(s.defaultLevels, 10) || 0,
        indexBase: parseInt(s.indexBase, 10) === 1 ? 1 : 0,
        reopenLast: !!s.reopenLast,
        lowMemoryMode: s.lowMemoryMode === true,
        idleReleaseMinutes: normalizeIdleRelease(s.idleReleaseMinutes),
        residentFileLimit: normalizeResidentLimit(s.residentFileLimit),
        restoreSession: s.restoreSession === undefined ? true : !!s.restoreSession,
        jsonlWrapArray: s.jsonlWrapArray === undefined ? true : !!s.jsonlWrapArray,
        strictJsonl: !!s.strictJsonl,
        limitValueHeight: !!s.limitValueHeight,
        valueMaxLines: parseInt(s.valueMaxLines, 10) || 6,
        railStyle: s.railStyle === 'dial' ? 'dial' : 'default',
        contextMenu: normalizeContextMenu(s.contextMenu)
      };

      if('template' in payload){
        template = normalizeTemplateSources(payload.template);
        for(const doc of docs) delete doc.maskedHiddenRules;
      }

      applyTheme(settings.theme);
      saveSettings();
      saveTemplate();
      if(settingsMask.classList.contains('open')) openSettings();
      applyRailStyle();
      applyContextMenuSettings();
      applyNodeSelectionStyle();
      applyIdeFoldVisibility();
      flushReadingSettings();
      showToast(t('设置已导入'));
    }catch(err){
      showToast(t('导入失败：') + err.message);
    }
  };
  reader.onerror = () => showToast(t('文件读取失败'));
  reader.readAsText(file, 'utf-8');
});

/* 启动时先应用两项与显示相关的设置，避免渲染完再变化的跳动 / 联动项状态不对 */
applyValueHeightSetting();
syncReopenControls();
applyTreeLayout();
applyBranchLineAction();
applyNodeSelectionStyle();
applyIdeFoldVisibility();

let nativeRestore = null;

/* ---------- 刷新后恢复上次打开的一组文件 ---------- */
(function restoreOpenFiles(){
  if(!settings.reopenLast) return;

  let rec = null;
  try{ rec = JSON.parse(localStorage.getItem(LASTFILE_KEY)); }catch(_){}
  if(!rec) return;

  /* 兼容旧的单文件副本格式：{ name, text, kind, rootLabel } */
  const list = Array.isArray(rec.docs)
    ? rec.docs
    : (typeof rec.text === 'string' && rec.name ? [rec] : []);
  if(!list.length) return;

  const sessions = readSessions();
  if(desktop){
    const files = list.filter(item => typeof item?.path === 'string' && item.path);
    nativeRestore = { files, sessions, activeKey: rec.activeKey };
    return;
  }

  list.forEach(item => {
    if(!item || typeof item.text !== 'string' || !item.name) return;

    const size = Number(item.size) || new Blob([item.text]).size;
    if(needsIndex(size, settings.largeFileThresholdMiB)) return;
    const kind = item.kind === 'jsonl' || /\.(jsonl|ndjson|jsonlines)$/i.test(item.name) ? 'jsonl' : 'json';
    const doc = settings.lowMemoryMode ? makeDoc(item.name, size, item.text, kind) : buildDoc(item.text, item.name, size);
    if(settings.lowMemoryMode) doc.unloaded = 'restore';
    doc.temporary = !!item.temporary; doc.dirty = !!item.dirty;
    doc.design = item.design === true && doc.kind === 'json';
    if(Number.isSafeInteger(item.editedSize) || doc.dirty || doc.design) setEditedText(doc, item.text);
    if(item.rootLabel) doc.rootLabel = item.rootLabel;

    restoreDocSession(doc, sessionFor(doc, sessions));
    docs.push(doc);
  });

  if(!docs.length){
    /* 副本全坏了：清掉，别让它拖累之后每次启动 */
    try{ localStorage.removeItem(LASTFILE_KEY); }catch(_){}
    return;
  }

  /* 恢复到上次停留的那一份；找不到就退回最后一份 */
  const active = docs.find(d => docKey(d) === rec.activeKey) || docs[docs.length - 1];
  activateDoc(active.id);
})();

/* 读回每个文档的会话（展开层级 + 视图位置），兼容旧的单文件格式 */
function readSessions(){
  if(!settings.restoreSession) return {};

  try{
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if(!s || typeof s !== 'object') return {};
    if(s.docs && typeof s.docs === 'object') return s.docs;
    if(s.file) return { [s.file]: { paths: s.paths || [], view: s.view || null } };
  }catch(_){}
  return {};
}

function restoreDocSession(doc, session){
  if(!session || typeof session !== 'object') return;
  if(Array.isArray(session.paths)) doc.openPaths = session.paths.filter(path => typeof path === 'string');
  if(session.view) doc.view = session.view;
  if(session.pageOffsets && typeof session.pageOffsets === 'object'){
    doc.pageOffsets = Object.fromEntries(Object.entries(session.pageOffsets)
      .filter(([path, offset]) => path.startsWith('$') && Number.isSafeInteger(offset) && offset > 0));
  }
  if(['tree','ide'].includes(session.viewMode)) doc.viewOverride = session.viewMode;
  if(session.design === true && canDesign(doc)){
    doc.design = true;
    if(['tree','ide'].includes(session.designPreviousView)) doc.designPreviousView = session.designPreviousView;
  }
  const ide = session.ide;
  if(!ide || typeof ide !== 'object') return;
  if(Number.isFinite(ide.zoom)) doc.ideZoom = clamp(ide.zoom, 70, 200);
  if(Number.isFinite(ide.scrollTop)) doc.ideScrollTop = Math.max(0, ide.scrollTop);
  if(Number.isFinite(ide.scrollLeft)) doc.ideScrollLeft = Math.max(0, ide.scrollLeft);
  if(Array.isArray(ide.folds)) doc.ideFolds = new Set(ide.folds.filter(line => Number.isInteger(line) && line >= 0 && line < 20000));
  if(Number.isSafeInteger(ide.selection?.start) && Number.isSafeInteger(ide.selection?.end)){
    doc.ideSelection = {
      start:Math.max(0, ide.selection.start),
      end:Math.max(0, ide.selection.end),
      direction:['forward','backward'].includes(ide.selection.direction) ? ide.selection.direction : 'none'
    };
  }
}

/* 桌面会话按完整路径定位；网页旧会话保留文件名兼容。 */
function sessionFor(doc, sessions){
  const key = docKey(doc);
  if(sessions[key]) return sessions[key];
  if(doc.path) return null;
  if(sessions[doc.name]) return sessions[doc.name];

  const hit = Object.keys(sessions).find(k => k.startsWith(doc.name + '::'));
  return hit ? sessions[hit] : null;
}

recordTemplateBtn.addEventListener('click', recordTemplate);
recordTemplateBtn2.addEventListener('click', () => {
  recordTemplate();
});

applyTemplateBtn.addEventListener('click', async () => {
  expansionGeneration++;
  closeSettings();
  const deepest = await applyTemplate();
  if(deepest){
    requestAnimationFrame(() => { if(deepest.isConnected) centerNode(deepest); });
    showToast(t('模板已应用'));
  }else{
    showToast(t('模板未命中任何节点（结构可能不一致）'));
  }
});

clearTemplateBtn.addEventListener('click', () => {
  template = null;
  for(const doc of docs) delete doc.maskedHiddenRules;
  try{ localStorage.removeItem(TEMPLATE_KEY); }catch(_){}
  updateTemplateStatus();
  /* 就地重建当前文档：模板隐藏掉的字段要当场恢复显示，而不是等下次切文件 */
  if(!ideActive) refreshTemplateVisibility();
  showToast(t('模板已清除'));
});

/* ---------- 结构模板编辑器（思维导图画布模式） ---------- */
const editorClose = document.getElementById('editorClose');
const editorBtn = document.getElementById('editorBtn');
const editorTree = document.getElementById('editorTree');
const editorViewport = document.getElementById('editorViewport');
const editorWorld = document.getElementById('editorWorld');
const editorCount = document.getElementById('editorCount');
const editorSaveBtn = document.getElementById('editorSaveBtn');
const editorZoomInBtn = document.getElementById('editorZoomInBtn');
const editorZoomOutBtn = document.getElementById('editorZoomOutBtn');
const editorZoomLabel = document.getElementById('editorZoomLabel');

const editorView = createCanvasView(editorViewport, editorWorld, editorZoomLabel);

/* 编辑器工作副本：打开时从模板拷贝，保存时写回 */
let editorHidden = new Set();
let editorBaseline = new Set(), editorDoc = null;
const editorDrafts = new WeakMap();

function openEditor(){
  /* 用文档而不是 parsedData 判断：根值是 null / false / 0 也是合法数据 */
  const doc = activeDoc();
  if(!doc || doc.error){ showToast(t('请先打开文件')); return; }
  if(templateEditing) return;
  closeMenu();
  if(!findPanel.hidden) closeFindPanel(false);
  templateEditing = true;
  syncDesignControls();
  syncDocumentMenu();
  enterEditorFind();
  viewer.classList.add('template-editing');
  fileSub.textContent = t('模板编辑模式 · 勾选显示字段 · 切换文件时保留草稿');
  fileSub.title = '';
  editorDoc = doc;
  editorBaseline = getHiddenSet(null);
  editorHidden = new Set(editorBaseline);
  const draft = editorDrafts.get(doc);
  if(draft){
    for(const path of draft.show) editorHidden.delete(path);
    for(const path of draft.hide) editorHidden.add(path);
  }
  renderEditorTree();
  editorView.reset();
  void expandOne(editorTree.firstElementChild);
  editorViewport.focus({preventScroll:true});
}

function closeEditor(discardChanges = false){
  if(!templateEditing) return;
  if(discardChanges) editorDrafts.delete(editorDoc);
  else{
    const show = [...editorBaseline].filter(path => !editorHidden.has(path));
    const hide = [...editorHidden].filter(path => !editorBaseline.has(path));
    if(show.length || hide.length) editorDrafts.set(editorDoc, {show, hide});
    else editorDrafts.delete(editorDoc);
  }
  editorDoc = null;
  templateEditing = false;
  syncDesignControls();
  syncDocumentMenu();
  if(!findPanel.hidden) closeFindPanel(false);
  resetEditorSearch();
  leaveEditorFind();
  expansionGeneration++;
  discardPagedTree(editorTree);
  editorTree.replaceChildren();
  viewer.classList.remove('template-editing');
  const doc = activeDoc();
  if(doc) updateDocHeader(doc);
}

function renderEditorTree(){
  expansionGeneration++;
  discardPagedTree(editorTree);
  editorTree.textContent = '';
  const source = activeDoc().source;
  const root = createEditorNode('root', source.getRoot(), [], true, false, source);
  editorTree.appendChild(root);
  updateEditorCount();
  updateEditorVirtualization();
}

/* 编辑器虚拟化：与主视图同策略，大结构同样流畅 */
function updateEditorVirtualization(){
  const n = editorTree.querySelectorAll('.tree-node').length;
  editorTree.classList.toggle('virtualized', n > CV_THRESHOLD);
}

function updateEditorCount(){
  editorCount.textContent = editorHidden.size
    ? msg`${editorHidden.size} 个字段将隐藏`
    : t('全部字段显示');
}

/* 编辑器节点：完全复用主视图的树结构 / 卡片样式，额外挂一个勾选框 */
function createEditorNode(key, descriptor, path, isRoot=false, isArrayItem=false, source){
  const isBranch = descriptor.type === 'object' || descriptor.type === 'array';
  const normPath = normalizePath(encodePath(path));

  const node = document.createElement('div');
  node.className = 'tree-node ed-node'
    + (isBranch ? ' branch' : '')
    + (isRoot ? ' root-node' : '');
  node._path = path;                 /* 与主视图一致：序号重标要按真实下标取标签 */
  node.dataset.path = encodePath(path);
  node._childrenType = descriptor.type;
  node._isArrayItem = isArrayItem;   /* 数组元素：序号标签可随设置实时切换 */

  const main = document.createElement('div');
  main.className = 'node-main';

  const toggle = createNodeToggle(isBranch);

  const card = document.createElement('div');
  card.className = 'node-card ed-card';

  /* 可见性勾选框 */
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ed-check';
  cb.checked = !editorHidden.has(normPath);
  cb.disabled = isRoot;   /* 根节点不可隐藏 */
  cb.title = isRoot ? t('根节点不可隐藏') : t('取消勾选将在主视图中隐藏该字段及其子级');
  node._setTemplateVisible = visible => {
    cb.checked = visible;
    card.classList.toggle('hidden-field', !visible);
  };
  cb.addEventListener('click', e => e.stopPropagation());
  cb.addEventListener('change', () => {
    if(cb.checked) editorHidden.delete(normPath);
    else editorHidden.add(normPath);
    node._setTemplateVisible(cb.checked);
    updateEditorCount();
    syncEditorVisibilityButton();
  });
  if(!cb.checked) card.classList.add('hidden-field');
  card.appendChild(cb);

  /* 「隐藏」标签：显示与否由 .hidden-field 类通过 CSS 控制 */
  const hideTag = document.createElement('span');
  hideTag.className = 'ed-hidden-tag';
  hideTag.textContent = t('隐藏');
  card.appendChild(hideTag);

  const keyEl = document.createElement('span');
  keyEl.className = 'node-key';
  keyEl.textContent = key;
  card.appendChild(keyEl);
  node._keyEl = keyEl;

  if(isBranch){
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${descriptor.type === 'array' ? 'Array' : 'Object'} · ${descriptor.childCount}`;
    card.appendChild(badge);

    if(descriptor.type === 'array'){
      const hint = document.createElement('span');
      hint.className = 'ed-hint';
      hint.textContent = t('仅第一项结构');
      card.appendChild(hint);
    }
  }else{
    const typeEl = document.createElement('span');
    typeEl.className = 'badge';
    typeEl.textContent = descriptor.type;
    card.appendChild(typeEl);
  }

  main.append(toggle, card);
  node.appendChild(main);

  /* 点击卡片 = 切换显示/隐藏 */
  card.addEventListener('click', () => {
    if(cb.disabled) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  });

  if(isBranch){
    const children = document.createElement('div');
    children.className = 'children';
    node.appendChild(children);

    const ensureChildren = pagedChildren(node, children, source, descriptor.path, item =>
      createEditorNode(item.arrayItem ? arrayIndexLabel(item.key) : String(item.key), item,
        path.concat(item.key), false, item.arrayItem, source), updateEditorVirtualization, true);

    const toggleNode = e => {
      e.stopPropagation();
      expansionGeneration++;
      node.classList.toggle('open');
      if(node.classList.contains('open')) ensureChildren();
      else node._discardChildren?.();
      updateEditorVirtualization();
    };
    toggle.addEventListener('click', toggleNode);
  }

  return node;
}

async function editorExpandAll(){
  await expandVisible(editorTree.firstElementChild, editorTree);
  updateEditorVirtualization();
}

function editorCollapseAll(){
  expansionGeneration++;
  editorTree.firstElementChild?._discardChildren?.();
  editorTree.querySelectorAll('.tree-node.open')
    .forEach(n => n.classList.remove('open'));
  updateEditorVirtualization();
}

editorBtn.addEventListener('click', () => { closeMoreMenu(); openEditor(); });
editorClose.addEventListener('click', () => { closeEditor(true); document.getElementById('moreBtn').focus(); });
editorZoomInBtn.addEventListener('click', () => editorView.zoomAt(1.12));
editorZoomOutBtn.addEventListener('click', () => editorView.zoomAt(0.89));

editorSaveBtn.addEventListener('click', () => {
  if(!templateEditing) return;
  closeEditor(true);
  saveHiddenRules(editorHidden);
  showToast(editorHidden.size
    ? msg`已应用：隐藏 ${editorHidden.size} 个字段`
    : t('已应用：全部字段显示'));
  openAnotherBtn.focus();
});

const editorSearchInput = document.getElementById('editorSearchInput');
const editorSearchCount = document.getElementById('editorSearchCount');
const editorNextMatch = document.getElementById('editorNextMatch');
const editorVisibilityBtn = document.getElementById('editorVisibilityBtn');
const findOptionButtons = [['searchCaseBtn','caseSensitive'],['searchWordBtn','wholeWord'],['searchRegexBtn','regex']];
const editorFindOptions = {caseSensitive:false, wholeWord:false, regex:false};
let readerFindState;
let editorSearchTimer;
let editorSearchRequest;
let editorSearchQuery = '';
let editorHits = [];
let editorHitRules = new Set();
let editorResultsLimited = false;
let editorHitIndex = -1;
let editorFocusGeneration = 0;

function syncFindOptionButtons(options){
  for(const [id, key] of findOptionButtons){
    document.getElementById(id).setAttribute('aria-pressed', String(options[key]));
  }
}

function enterEditorFind(){
  clearTimeout(searchTimer);
  searchGeneration++;
  focusGeneration++;
  readerFindState = {value:searchInput.value, count:searchCount.textContent, title:searchCount.title, error:searchError.textContent};
  searchInput.value = '';
  searchInput.placeholder = t('搜索键名…');
  document.getElementById('findPanelTitle').textContent = t('查找键名');
  searchScopeBtn.hidden = true;
  editorVisibilityBtn.hidden = false;
  syncFindOptionButtons(editorFindOptions);
  clearEditorMatches();
}

function leaveEditorFind(){
  searchInput.value = readerFindState.value;
  searchInput.placeholder = t('搜索键名或值…');
  searchCount.textContent = readerFindState.count === t('搜索中…') ? '' : readerFindState.count;
  searchCount.title = readerFindState.title;
  nextMatchBtn.disabled = prevMatchBtn.disabled = !matches.length;
  setSearchError(readerFindState.error || '');
  document.getElementById('findPanelTitle').textContent = t('查找');
  searchScopeBtn.hidden = false;
  editorVisibilityBtn.hidden = true;
  syncFindOptionButtons(searchOptions);
  readerFindState = null;
}

function editorResultsHidden(){
  return editorHitRules.size > 0 && [...editorHitRules].every(path => editorHidden.has(path));
}

function syncEditorVisibilityButton(){
  const hidden = editorResultsHidden();
  const label = hidden ? t('显示匹配节点') : t('隐藏匹配节点');
  editorVisibilityBtn.dataset.hidden = String(hidden);
  editorVisibilityBtn.disabled = editorResultsLimited || !editorHitRules.size;
  editorVisibilityBtn.title = editorResultsLimited ? t('结果不完整，请缩小搜索范围后批量操作') : label;
  editorVisibilityBtn.setAttribute('aria-label', label);
}

function setEditorSearchFeedback(value, error = '', hint = ''){
  editorSearchCount.textContent = value;
  editorSearchCount.title = hint;
  editorNextMatch.disabled = !editorHits.length;
  if(!templateEditing) return;
  searchCount.textContent = value;
  searchCount.title = hint;
  nextMatchBtn.disabled = prevMatchBtn.disabled = !editorHits.length;
  searchError.hidden = !error;
  searchError.textContent = error;
  searchInput.setAttribute('aria-invalid', String(!!error));
  syncEditorVisibilityButton();
}

function clearEditorMatches(){
  clearTimeout(editorSearchTimer);
  editorSearchRequest?.abort();
  editorFocusGeneration++;
  editorSearchQuery = '';
  editorHits = [];
  editorHitRules = new Set();
  editorResultsLimited = false;
  editorHitIndex = -1;
  setEditorSearchFeedback('');
  editorTree.querySelectorAll('.current-match').forEach(node => node.classList.remove('current-match'));
}

function resetEditorSearch(){
  clearEditorMatches();
  editorSearchInput.value = '';
}

async function scanEditorKeys(source, matcher, signal){
  const root = source.getRoot();
  const results = [];
  const pending = [{node:root, offset:0}];
  let visited = 0;
  let pages = 0;
  while(pending.length){
    signal.throwIfAborted();
    const {node, offset} = pending.pop();
    if(offset === 0 && node.path.length){
      if(++visited > 50000) return {results, limited:true};
      if(typeof node.key === 'string' && matcher.test(node.key)){
        if(results.length === 1000) return {results, limited:true};
        results.push(node.path);
      }
    }
    if(node.type !== 'array' && node.type !== 'object') continue;
    const page = await source.getChildren(node.path, {offset, firstArrayOnly:true, signal, cache:false});
    if(page.end > offset && page.end < page.total) pending.push({node, offset:page.end});
    for(let index = page.items.length - 1; index >= 0; index--){
      pending.push({node:page.items[index], offset:0});
    }
    if(++pages % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return {results, limited:false};
}

async function focusEditorMatch(index){
  if(!editorHits.length) return;
  const generation = ++editorFocusGeneration;
  editorHitIndex = (index + editorHits.length) % editorHits.length;
  let node = editorTree.firstElementChild;
  for(const key of editorHits[editorHitIndex]){
    if(!node?._ensureChildren) return;
    await expandOne(node, key);
    if(generation !== editorFocusGeneration || !templateEditing) return;
    node = [...(directChildrenContainer(node)?.children || [])].find(child => child._pageKey === key);
  }
  if(!node) return;
  editorTree.querySelectorAll('.current-match').forEach(match => match.classList.remove('current-match'));
  node.classList.add('current-match');
  const target = node.firstElementChild.getBoundingClientRect();
  const bounds = editorViewport.getBoundingClientRect();
  editorView.state.x += bounds.left + bounds.width / 2 - (target.left + target.width / 2);
  editorView.state.y += bounds.top + bounds.height / 2 - (target.top + target.height / 2);
  editorView.apply();
}

async function searchEditorKeys(){
  const query = editorSearchInput.value.trim();
  clearEditorMatches();
  if(!query || !templateEditing) return;
  editorSearchQuery = query;
  let matcher;
  try{
    matcher = compileSearch(query, editorFindOptions);
  }catch(error){
    setEditorSearchFeedback(t('表达式无效'), error.message);
    return;
  }
  const request = new AbortController();
  editorSearchRequest = request;
  setEditorSearchFeedback(t('搜索中…'));
  try{
    const {results, limited} = await scanEditorKeys(activeDoc().source, matcher, request.signal);
    if(request.signal.aborted) return;
    editorHits = results;
    editorHitRules = new Set(results.map(path => normalizePath(encodePath(path))));
    editorResultsLimited = limited;
    const count = limited ? (results.length ? msg`${results.length}+ 项` : t('已达上限'))
      : results.length ? msg`${results.length} 项` : t('无匹配');
    setEditorSearchFeedback(count, '', limited ? t('已达搜索上限，请缩小关键词范围') : '');
    await focusEditorMatch(0);
  }catch(error){
    if(!request.signal.aborted) setEditorSearchFeedback(t('查找失败'), error.message);
  }
}

function queueEditorSearch(event){
  if(event?.isComposing) return;
  clearEditorMatches();
  editorSearchTimer = setTimeout(searchEditorKeys, 180);
}
function syncEditorQuickSearch(event){
  if(event?.isComposing) return;
  searchInput.value = editorSearchInput.value;
  queueEditorSearch(event);
}
editorSearchInput.addEventListener('input', syncEditorQuickSearch);
editorSearchInput.addEventListener('compositionend', syncEditorQuickSearch);
editorSearchInput.addEventListener('keydown', event => {
  if(event.isComposing || event.key !== 'Enter') return;
  event.preventDefault();
  if(editorSearchQuery !== editorSearchInput.value.trim()) void searchEditorKeys();
  else void focusEditorMatch(editorHitIndex + (event.shiftKey ? -1 : 1));
});
editorNextMatch.addEventListener('click', () => { void focusEditorMatch(editorHitIndex + 1); });
editorVisibilityBtn.addEventListener('click', () => {
  if(!templateEditing || editorVisibilityBtn.disabled) return;
  const show = editorResultsHidden();
  for(const path of editorHitRules){
    if(show) editorHidden.delete(path);
    else editorHidden.add(path);
  }
  for(const node of editorTree.querySelectorAll('.ed-node')){
    const path = normalizePath(encodePath(node._path));
    if(editorHitRules.has(path)) node._setTemplateVisible(show);
  }
  updateEditorCount();
  syncEditorVisibilityButton();
  showToast(msg`已${show ? t('显示') : t('隐藏')} ${editorHitRules.size} 条匹配规则`);
});


/* Value editing works on an independent document revision. */
document.getElementById('documentActions').hidden = desktop;
document.getElementById('ideInput').addEventListener('input', e => {
  if(e.isComposing) return;
  const group = ['insertText','deleteContentBackward','deleteContentForward'].includes(e.inputType) ? e.inputType : null;
  handleIdeInput(e.target.value, group);
});
document.getElementById('ideInput').addEventListener('compositionend', e => handleIdeInput(e.target.value));
for(const event of ['blur','pointerdown']) document.getElementById('ideInput').addEventListener(event, () => {
  if(activeDoc()) activeDoc().ideEditGroup = null;
});
document.getElementById('ideInput').addEventListener('keydown', e => {
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key) && activeDoc()){
    activeDoc().ideEditGroup = null;
  }
});
document.getElementById('ideInput').addEventListener('scroll', () => {
  syncIdeScroll();
  if(ideActive) scheduleSessionSave();
});
for(const event of ['click','keyup','select','focus']) document.getElementById('ideInput').addEventListener(event, () => {
  updateIdeScope();
  if(ideActive) scheduleSessionSave();
});
window.addEventListener('resize', syncIdeScroll);
if(typeof ResizeObserver === 'function') new ResizeObserver(syncIdeScroll).observe(document.getElementById('ideInput'));
document.getElementById('formatIdeBtn').addEventListener('click', formatIde);
document.getElementById('ideInput').addEventListener('wheel', e => {
  if(!e.ctrlKey && !e.metaKey) return;
  e.preventDefault(); setIdeZoom((activeDoc()?.ideZoom || 100) + (e.deltaY > 0 ? -10 : 10));
}, {passive:false});
document.getElementById('valueEditText').addEventListener('input', resizeNodeEditor);
document.getElementById('valueEditType').addEventListener('change', e => {
  if(editingNode?.doc.design){
    const defaults = {'':'', string:'', number:'0', boolean:'false', null:'null', object:'{}', array:'[]'};
    const text = document.getElementById('valueEditText');
    if(text.value === defaults[editingNode.type]) text.value = defaults[e.target.value];
    editingNode.type = e.target.value;
  }
  resizeNodeEditor();
});
window.addEventListener('resize', resizeNodeEditor);
document.getElementById('optViewMode').addEventListener('change', e => {
  if(!leaveIde()){ e.target.value = settings.viewMode; return; }
  changeReadingSetting('viewMode', normalizeViewMode(e.target.value));
});
function switchDocumentView(){
  const doc = activeDoc(); if(!doc) return;
  if(!ideActive && document.getElementById('switchViewBtn').disabled){
    showToast(doc.source?.indexed || needsIndex(doc.size, settings.largeFileThresholdMiB)
      ? t('大文件仅支持树形视图') : t('当前文档无法切换到 IDE 视图'));
    return;
  }
  if(!leaveIde()) return;
  if(ideActive) doc.ideDraft = undefined;
  snapshotDoc(); doc.viewOverride = ideActive ? 'tree' : 'ide'; activateDoc(doc.id);
  saveSession();
  (ideActive ? document.getElementById('ideInput') : viewport).focus({preventScroll:true});
}
document.getElementById('switchViewBtn').addEventListener('click', switchDocumentView);
for(const action of ['child','sibling','rename','delete']){
  const id = 'design' + action[0].toUpperCase() + action.slice(1);
  document.getElementById(id).addEventListener('click', () => beginTopicEdit(action));
}
document.getElementById('designUndo').addEventListener('click', () => {
  document.getElementById('undoEditBtn').click();
  viewport.focus({preventScroll:true});
});
document.getElementById('designSave').addEventListener('click', () => saveCurrentDocument());
document.getElementById('designTopicCancel').addEventListener('click', () => document.getElementById('designTopicDialog').close());
document.getElementById('designTopicDialog').addEventListener('close', () => {
  if(!document.getElementById('designTopicDialog').open) designTopic = null;
});
document.getElementById('designTopicForm').addEventListener('submit', event => {
  event.preventDefault();
  if(!designTopic) return;
  try {
    const name = document.getElementById('designTopicName').value.trim();
    if(!name) throw new Error(t('请输入主题名称'));
    commitTopicEdit(designTopic, designTopic.action, name);
  } catch(error){ document.getElementById('designTopicError').textContent = error.message; }
});
tree.addEventListener('dblclick', event => {
  if(event.target.closest('button') || !event.target.closest('.node-card')) return;
  const node = event.target.closest('.tree-node');
  if(settings.topicDoubleClick === 'value'){
    if(designTarget(node)) beginNodeEdit(node);
  }else beginTopicEdit('rename', node);
});
document.getElementById('optTopicDoubleClick').addEventListener('change', e => {
  settings.topicDoubleClick = e.target.value === 'value' ? 'value' : 'rename';
  saveSettings();
});
document.getElementById('optVimEditing').addEventListener('change', e => {
  settings.vimEditing = e.target.checked;
  vimPrefix = null;
  saveSettings();
});
document.getElementById('optTopicDock').addEventListener('change', e => {
  settings.showTopicDock = e.target.checked;
  syncDesignControls();
  saveSettings();
});
document.getElementById('editModeBtn').addEventListener('click', () => setEditMode(!editMode, true));
document.getElementById('designModeBtn').addEventListener('click', toggleDesignMode);
document.getElementById('ctxEditNode').addEventListener('click', () => beginNodeEdit(ctxTarget));
document.getElementById('ctxTopicValue').addEventListener('click', () => beginNodeEdit(ctxTarget));
tree.addEventListener('click', e => {
  if(!editMode || e.target.closest('button,input,select')) return;
  const card = e.target.closest('.node-card');
  if(card){ e.stopPropagation(); beginNodeEdit(card.closest('.tree-node')); }
}, true);
document.getElementById('valueEditDialog').addEventListener('close', () => { editingNode = null; });
document.getElementById('valueEditCancel').addEventListener('click', () => { editingNode = null; document.getElementById('valueEditDialog').close(); });
document.getElementById('valueEditForm').addEventListener('submit', e => {
  e.preventDefault();
  try { applyNodeEdit(); } catch(error){ document.getElementById('valueEditError').textContent = error.message; }
});
document.getElementById('discardEditCancel').addEventListener('click', () => finishDiscardEdits(false));
document.getElementById('discardEditConfirm').addEventListener('click', () => finishDiscardEdits(true));
document.getElementById('discardEditDialog').addEventListener('cancel', e => { e.preventDefault(); finishDiscardEdits(false); });
function stepEditHistory(redo = false){
  const doc = activeDoc(), previous = (redo ? doc?.redoHistory : doc?.editHistory)?.pop();
  if(!previous) return;
  const { topicSelection, ...revision } = previous;
  snapshotDoc();
  const opposite = redo ? (doc.editHistory ||= []) : (doc.redoHistory ||= []);
  const current = editRevision(doc, Object.hasOwn(revision, 'openPaths'));
  if(doc.design && selectedCopyNode) current.topicSelection = selectedCopyNode._path;
  opposite.push(current);
  doc.ideEditGroup = null;
  doc.ideFolds?.clear(); Object.assign(doc, revision);
  if(doc.savedText !== undefined) doc.dirty = doc.temporary || doc.text !== doc.savedText;
  doc.searchQuery = '';
  persistDesignDraft(doc);
  activateDoc(doc.id, topicSelection);
}
document.getElementById('deleteTopicDialog').addEventListener('close', () => {
  if(!document.getElementById('deleteTopicDialog').open) pendingTopicDeletion = null;
});
document.getElementById('deleteTopicCancel').addEventListener('click', () => document.getElementById('deleteTopicDialog').close());
document.getElementById('deleteTopicConfirm').addEventListener('click', () => {
  const target = pendingTopicDeletion;
  document.getElementById('deleteTopicDialog').close();
  if(target?.doc === activeDoc()) commitTopicAction(target, 'delete');
});
document.getElementById('undoEditBtn').addEventListener('click', () => stepEditHistory());
document.getElementById('redoEditBtn').addEventListener('click', () => stepEditHistory(true));
async function saveCurrentDocument(copy = false){
  const doc = activeDoc(); if(!doc?.dirty || doc.saving || doc.source?.indexed) return;
  if(doc.ideError){ showToast(t('请先修正 JSON 语法，再保存')); return; }
  doc.ideEditGroup = null;
  if(!copy && desktop && doc.path && doc.kind === 'jsonl' && doc.bad?.length){
    showToast(t('文件中有被跳过的行，请使用另存为，避免覆盖原始记录')); return;
  }
  const revision = doc.text;
  const extension = doc.kind === 'jsonl' ? 'jsonl' : 'json';
  // The native copy dialog must suggest a distinct path from the open file.
  const name = desktop && doc.path && !doc.temporary ? doc.name.replace(/\.[^.]+$/, '') + '-edited.' + extension : doc.name;
  const savesOriginal = desktop && doc.path && !copy;
  doc.saving = true; syncEditing();
  try {
    if(savesOriginal){
      await saveNativeDocument(doc.path, revision, doc.diskText ?? doc.savedText ?? doc.text);
      doc.diskText = revision;
    }else if(desktop){
      const path = await saveDocumentCopy(name, revision, doc.path || null, docs.filter(d => d !== doc && d.path).map(d => d.path));
      if(!path) return;
      if(doc.temporary){
        doc.path = path; doc.name = path.split(/[\\/]/).pop();
        doc.identity = (navigator.userAgentData?.platform || navigator.platform || '').startsWith('Win') ? path.toLowerCase() : path;
        doc.diskText = revision; doc.temporary = false;
      }
    }
    else {
      const url = URL.createObjectURL(new Blob([revision], {type:'application/json;charset=utf-8'}));
      const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      if(doc.design) doc.temporary = false;
    }
    doc.savedText = revision; doc.dirty = doc.text !== revision;
    const messages = [savesOriginal ? t('已保存到原文件') : desktop ? t('已另存为文件') : t('已开始下载')];
    const notify = message => messages.push(message);
    persistDesignDraft(doc, false, notify);
    renderRail(); saveReopenCopy(notify); saveSession(notify);
    if(doc === activeDoc()){ updateDocHeader(doc); syncEditing(); updateWindowTitle(doc.name); }
    showToast(messages.join('。'));
  } catch(error){
    if(savesOriginal && doc === activeDoc() && String(error?.cause ?? error).includes('文件已被其他程序修改')){
      document.getElementById('saveConflictDialog').showModal();
    }else showToast((copy ? t('另存为失败：') : t('保存失败：')) + error);
  }
  finally {
    doc.saving = false;
    if(doc === activeDoc()) syncEditing();
    if(enforceResidentLimit()) renderRail();
    scheduleMemoryRelease();
  }
}
document.getElementById('saveConflictCancel').addEventListener('click', () => document.getElementById('saveConflictDialog').close());
document.getElementById('saveConflictCopy').addEventListener('click', () => {
  document.getElementById('saveConflictDialog').close();
  void saveCurrentDocument(true);
});
document.getElementById('saveBtn').addEventListener('click', () => saveCurrentDocument());
document.getElementById('saveCopyBtn').addEventListener('click', () => saveCurrentDocument(true));
window.addEventListener('beforeunload', e => { if(docs.some(d => d.dirty)){ e.preventDefault(); e.returnValue = ''; } });
if(desktop) guardEditedClose(() => docs.some(d => d.dirty), async () => {
  if(!await confirmDiscardEdits()) return false;
  for(const doc of docs) persistDesignDraft(doc, true);
  return true;
}, saveSession).catch(console.error);

/* ---------- 「更多」菜单 ---------- */
const moreBtn = document.getElementById('moreBtn');
const moreMenu = document.getElementById('moreMenu');

function openMoreMenu(){ moreMenu.classList.add('open'); }
function closeMoreMenu(){ moreMenu.classList.remove('open'); }

moreBtn.addEventListener('click', e => {
  e.stopPropagation();
  moreMenu.classList.contains('open') ? closeMoreMenu() : openMoreMenu();
});
moreMenu.addEventListener('click', e => {
  if(e.target.closest('button')) closeMoreMenu();
});
window.addEventListener('click', closeMoreMenu);
window.addEventListener('blur', closeMoreMenu);

window.addEventListener('click', closeMenu);
window.addEventListener('blur', closeMenu);
window.addEventListener('contextmenu', e => {
  // Node cards handle their own menu above; suppress WebView/browser menus elsewhere.
  e.preventDefault();
  closeMenu();
});

function canvasParent(node){
  const parent = node.parentElement?.parentElement;
  return parent?.classList.contains('tree-node') ? parent : null;
}

function visibleChildren(node){
  return node.classList.contains('open') ? childNodesToVisit(node, false) : [];
}

function lastVisibleNode(node){
  let child;
  while((child = visibleChildren(node).at(-1))) node = child;
  return node;
}

function visibleNeighbor(node, direction){
  if(direction > 0){
    const child = visibleChildren(node)[0];
    if(child) return child;
  }
  for(let parent = canvasParent(node); parent; parent = canvasParent(node)){
    const siblings = visibleChildren(parent);
    const index = siblings.indexOf(node);
    if(index < 0) return parent;
    const sibling = siblings[index + direction];
    if(sibling) return direction > 0 ? sibling : lastVisibleNode(sibling);
    if(direction < 0) return parent;
    node = parent;
  }
  return null;
}

function selectVimNode(node){
  if(!node || node.isConnected === false) return;
  focusGeneration++;
  nodeBudget.touch(node);
  selectCopyNode(node);
  selectedSearchPath = node._source === activeDoc()?.source ? [...node._path] : null;
  pathText.textContent = t('路径：') + node.dataset.path;
  revealCanvasNode(node);
}

async function enterVimBranch(node){
  if(!isBranchEl(node)) return;
  const selection = selectedCopyNode, generation = ++expansionGeneration;
  await expandOne(node);
  if(generation === expansionGeneration && selection === selectedCopyNode) selectVimNode(visibleChildren(node)[0]);
}

function handleVimTreeKey(event){
  // Uppercase fold commands require Shift between the two letter presses.
  if(event.target === viewport && event.key === 'Shift') return false;
  const prefix = vimPrefix;
  vimPrefix = null;
  const doc = activeDoc(), root = tree.firstElementChild;
  if(!settings.vimEditing || !doc || doc.error || !root || event.target !== viewport || ideActive || templateEditing ||
    event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = event.key;
  if(key === 'Escape') return prefix !== null && Date.now() < prefix.expires;
  if(editMode) return false;
  if(event.repeat && !['h','j','k'].includes(key)) return false;

  const node = selectedCopyNode && selectedCopyNode.isConnected !== false ? selectedCopyNode : root;
  if(prefix && Date.now() < prefix.expires && !event.repeat){
    switch(prefix.key + key){
      case 'gg': selectVimNode(root); return true;
      case 'yy': selectVimNode(node); void copyNodeContent(node); return true;
      case 'dd': return beginTopicEdit('delete', node);
      case 'zo':
      case 'zc':
      case 'za':
        if(isBranchEl(node)){
          if(key === 'c' || (key === 'a' && node.classList.contains('open'))) collapseSubtree(node);
          else { expansionGeneration++; void expandOne(node); }
          selectVimNode(node);
        }
        return true;
      case 'zR': void expandAll(); return true;
      case 'zM': collapseAll(); selectVimNode(root); return true;
      default: return false;
    }
  }
  switch(key){
    case 'h': selectVimNode(canvasParent(node) || node); return true;
    case 'j':
    case 'k': selectVimNode(visibleNeighbor(node, key === 'j' ? 1 : -1) || node); return true;
    case 'l': void enterVimBranch(node); return true;
    case 'G': selectVimNode(lastVisibleNode(root)); return true;
    case 'g':
    case 'y':
    case 'z':
    case 'd':
      if(key === 'd' && !doc.design) return false;
      vimPrefix = { key, expires:Date.now() + 1200 };
      return true;
    case '/': openFindPanel(true); return true;
    case 'n':
    case 'N':
      if(matches.length) void focusMatch((currentMatchIndex + (key === 'n' ? 1 : -1) + matches.length) % matches.length, true);
      return true;
    case 'u': document.getElementById('undoEditBtn').click(); return true;
    case 'i':
      if(doc.design) return beginTopicEdit('rename', node);
      setEditMode(true, true); return true;
    case 'r':
      if(doc.design) return beginTopicEdit('rename', node);
      if(!canEditNode(node)) return false;
      beginNodeEdit(node); return true;
    case 'a': return beginTopicEdit('child', node);
    case 'o': return beginTopicEdit('sibling', node);
    default: return false;
  }
}

viewport.addEventListener('blur', () => { vimPrefix = null; });
document.addEventListener('pointerdown', () => { vimPrefix = null; });
document.addEventListener('keydown', e => {
  if(['valueEditDialog','designTopicDialog','discardEditDialog','deleteTopicDialog','saveConflictDialog'].some(id => document.getElementById(id).open)) return;
  if(canvasRulesDialog.open || document.getElementById('aboutDialog').open || document.getElementById('updateDialog').open) return;
  if(e.isComposing || e.getModifierState?.('AltGraph')) { vimPrefix = null; return; }
  const overlayOpen = ['settingsMask','modalMask'].some(id => document.getElementById(id).classList.contains('open'));
  if(e.key !== 'Escape' && overlayOpen) { vimPrefix = null; return; }
  const modifier = macPlatform ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.toLowerCase();
  const inIde = ideActive && (e.target === document.getElementById('ideInput') || e.target === document.getElementById('ideView') || e.target?.closest?.('#ideView'));
  const typing = inIde || !!e.target?.closest?.('input,textarea,select,[contenteditable]');
  const action = shortcutAction(e, macPlatform);
  const consume = callback => { e.preventDefault(); callback(); };
  if(!overlayOpen && handleVimTreeKey(e)){ e.preventDefault(); return; }
  if(e.target === viewport && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat){
    if(e.key === 'Escape' && findPanel.hidden && designTarget()){
      consume(() => { selectCopyNode(null); selectedSearchPath = null; }); return;
    }
    const topicAction = {Tab:'child', Enter:'sibling', F2:'rename', Delete:'delete'}[e.key];
    if(topicAction && beginTopicEdit(topicAction)){ e.preventDefault(); return; }
  }
  if(!templateEditing && !ideActive && !overlayOpen && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat){
    if(e.key === 'Escape' && !typing && editMode && findPanel.hidden){
      consume(() => setEditMode(false, true)); return;
    }
  }
  if(templateEditing){
    if(e.key === 'Escape') consume(() => findPanel.hidden ? editorClose.click() : closeFindPanel());
    else if(action === 'find') consume(openFindPanel);
    else if(action === 'save') consume(() => editorSaveBtn.click());
    else if(action === 'expandAll') consume(editorExpandAll);
    else if(action === 'collapseAll') consume(editorCollapseAll);
    else if(action === 'resetView') consume(() => editorView.reset());
    else if(action === 'nextMatch' || action === 'previousMatch')
      consume(() => focusEditorMatch(editorHitIndex + (action === 'nextMatch' ? 1 : -1)));
    else if(action === 'open' || action === 'newDocument') e.preventDefault();
    return;
  }
  if(action === 'copyNode' && !ideActive && !typing && selectedCopyNode && selectedCopyNode.isConnected !== false
    && (window.getSelection?.()?.isCollapsed ?? true)){
    consume(() => copyNodeContent(selectedCopyNode)); return;
  }
  if(action === 'save' || action === 'saveCopy') { consume(() => saveCurrentDocument(action === 'saveCopy')); return; }
  if(action === 'open') { consume(chooseFiles); return; }
  if(action === 'newDocument') { consume(newBlankDocument); return; }
  if(action === 'settings') { consume(openSettings); return; }
  if(action === 'about') { consume(openAbout); return; }
  if(action === 'switchView' && activeDoc()) { consume(switchDocumentView); return; }
  if(action === 'designMode' && activeDoc() && (!typing || inIde)) { consume(toggleDesignMode); return; }
  if(action === 'editMode' && activeDoc() && !ideActive) { consume(() => document.getElementById('editModeBtn').click()); return; }
  if(action === 'resetView' && activeDoc() && !activeDoc().error) { consume(() => ideActive ? setIdeZoom(100) : resetView()); return; }
  if(action === 'find' && activeDoc()) { consume(openFindPanel); return; }
  if(action === 'format' && ideActive) { consume(formatIde); return; }
  if(action === 'undo' && (inIde || !typing)) { consume(() => document.getElementById('undoEditBtn').click()); return; }
  if(action === 'redo' && (inIde || !typing)) { consume(() => document.getElementById('redoEditBtn').click()); return; }
  if(action === 'close' && activeDoc()) { consume(() => closeDoc(activeDocId)); return; }
  if((action === 'nextFile' || action === 'previousFile') && (!typing || inIde) && docs.length > 1) {
    consume(() => {
      const index = docs.findIndex(doc => doc.id === activeDocId);
      activateDoc(docs[(index + (action === 'nextFile' ? 1 : -1) + docs.length) % docs.length].id);
    }); return;
  }
  if((action === 'expandAll' || action === 'collapseAll') && !typing && !ideActive && activeDoc() && !activeDoc().error) {
    consume(() => (action === 'expandAll' ? expandAllBtn : collapseAllBtn).click()); return;
  }
  if((action === 'nextMatch' || action === 'previousMatch') && matches.length) {
    consume(() => focusMatch((currentMatchIndex + (action === 'previousMatch' ? -1 : 1) + matches.length) % matches.length)); return;
  }
  if(inIde && !e.isComposing){
    if(modifier && !e.altKey && ['+','=','-','0'].includes(e.key)){ e.preventDefault(); setIdeZoom(e.key === '0' ? 100 : (activeDoc().ideZoom || 100) + (e.key === '-' ? -10 : 10)); return; }
    if(e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey && key === 'f'){ e.preventDefault(); formatIde(); return; }
    if(e.key === 'Tab' && !e.shiftKey && e.target === document.getElementById('ideInput')){
      e.preventDefault(); const input = e.target;
      input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end'); handleIdeInput(input.value); return;
    }
  }
  if(modifier && !e.altKey && !e.shiftKey && key === 'w' && activeDoc() && !typing){
    e.preventDefault(); closeDoc(activeDocId); return;
  }
  if(e.key === 'F3' && !modifier && !e.altKey && matches.length){
    e.preventDefault(); focusMatch((currentMatchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length); return;
  }
  if(e.key === 'Escape'){
    if(!findPanel.hidden){ e.preventDefault(); closeFindPanel(); return; }
    clearTimeout(searchTimer);
    expansionGeneration++;
    searchGeneration++;
    if(searchCount.textContent === t('搜索中…')){
      clearTimeout(searchTimer);
      clearSearchHighlights();
      setSearchCount(t('已取消'));
    }
    if(selectedLoad === runningLoad && runningLoad) cancelFileLoad(runningLoad);
    else if(!runningLoad) activeLoad?.abort();
    closeMenu();
    closeModal();
    closeSettings();
  }
});

/* ---------- 搜索 ---------- */
function saveFindPlacement(){
  if(legacyFindPlacement) return;
  try { localStorage.setItem(findPlacementKey, JSON.stringify(findPlacement)); } catch { /* Optional preference. */ }
}
function positionFindPanel(x, y){
  if(findPanel.hidden) return;
  const width = window.innerWidth, height = window.innerHeight;
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const minTop = Math.max(12, toolbarBottom + 12);
  findPanel.style.maxHeight = `${Math.max(32, height - minTop - 12)}px`;
  const rect = findPanel.getBoundingClientRect();
  const freeWidth = width - rect.width;
  if(legacyFindPlacement){
    // Old default placements were saved as pixels along the toolbar. Restore their right anchor.
    if(legacyFindPlacement.y > minTop + 1){
      x ??= legacyFindPlacement.x;
      y ??= legacyFindPlacement.y;
    }
    legacyFindPlacement = null;
  }
  const anchoredLeft = findPlacement.edge === 'left' ? findPlacement.inset : freeWidth - findPlacement.inset;
  const left = clamp(x ?? anchoredLeft, 12, Math.max(12, freeWidth - 12));
  const top = clamp(y ?? minTop + findPlacement.top, minTop, Math.max(minTop, height - rect.height - 12));
  if(x !== undefined){
    findPlacement.edge = left <= freeWidth / 2 ? 'left' : 'right';
    findPlacement.inset = Math.max(12, findPlacement.edge === 'left' ? left : freeWidth - left);
  }
  if(y !== undefined) findPlacement.top = top - minTop;
  findPanel.style.left = `${left}px`;
  findPanel.style.top = `${top}px`;
  return { left, top };
}
function updateFindPin(){
  findPanel.dataset.pinned = String(findPlacement.pinned);
  pinFindBtn.setAttribute('aria-pressed', String(findPlacement.pinned));
  pinFindBtn.title = findPlacement.pinned ? t('取消固定后可拖动窗口') : t('锁定窗口当前位置');
  pinFindBtn.setAttribute('aria-label', findPlacement.pinned ? t('取消固定') : t('固定位置'));
}
let returnFindToCanvas = false;
function openFindPanel(fromCanvas = false){
  if(!activeDoc()) return;
  returnFindToCanvas = fromCanvas === true;
  closeMoreMenu();
  findPanel.hidden = false;
  updateFindPin();
  positionFindPanel();
  saveFindPlacement();
  searchInput.focus(); searchInput.select();
}
function closeFindPanel(restoreFocus = true){
  findPanel.hidden = true;
  findDrag = null;
  saveFindPlacement();
  const target = templateEditing ? editorSearchInput : returnFindToCanvas && !ideActive ? viewport : quickSearchInput;
  returnFindToCanvas = false;
  if(restoreFocus) target.focus({preventScroll:true});
}
document.getElementById('findBtn').addEventListener('click', openFindPanel);
document.getElementById('closeFindBtn').addEventListener('click', () => closeFindPanel());
pinFindBtn.addEventListener('click', () => {
  findDrag = null;
  findPlacement.pinned = !findPlacement.pinned;
  updateFindPin(); saveFindPlacement();
});
findDragHandle.addEventListener('pointerdown', e => {
  if(e.button !== 0 || findPlacement.pinned || e.target.closest('button')) return;
  const { left, top } = positionFindPanel();
  findDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, left, top };
  findDragHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});
findDragHandle.addEventListener('pointermove', e => {
  if(!findDrag || e.pointerId !== findDrag.id) return;
  positionFindPanel(findDrag.left + e.clientX - findDrag.x, findDrag.top + e.clientY - findDrag.y);
});
function endFindDrag(){ if(findDrag){ findDrag = null; saveFindPlacement(); } }
findDragHandle.addEventListener('pointerup', endFindDrag);
findDragHandle.addEventListener('pointercancel', endFindDrag);
findDragHandle.addEventListener('lostpointercapture', endFindDrag);
findDragHandle.addEventListener('keydown', e => {
  if(e.target !== findDragHandle || findPlacement.pinned) return;
  const delta = { ArrowLeft: [-10,0], ArrowRight: [10,0], ArrowUp: [0,-10], ArrowDown: [0,10] }[e.key];
  if(!delta) return;
  const { left, top } = positionFindPanel();
  e.preventDefault();
  positionFindPanel(delta[0] ? left + delta[0] : undefined, delta[1] ? top + delta[1] : undefined);
  saveFindPlacement();
});
window.addEventListener('resize', () => positionFindPanel());
if(typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => positionFindPanel());
  observer.observe(findPanel);
  observer.observe(document.querySelector('.toolbar'));
}
findPanel.addEventListener('keydown', e => {
  if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeFindPanel(); }
});
function setSearchCount(value){
  searchCount.textContent = value;
  quickSearchCount.textContent = value;
  quickNextMatchBtn.disabled = !matches.length;
}
function useQuickSearch(){
  searchInput.value = quickSearchInput.value;
  // A new toolbar query uses plain matching, even after an advanced search.
  for(const [id, option] of findOptionButtons){
    searchOptions[option] = false; document.getElementById(id).setAttribute('aria-pressed', 'false');
  }
  searchOptions.scopePath = null;
  searchScopeBtn.setAttribute('aria-pressed', 'false');
  searchScopeBtn.title = t('仅在选中节点内查找：先点击一个节点');
  tree.querySelectorAll('.search-scope-node').forEach(n => n.classList.remove('search-scope-node'));
}
quickSearchInput.addEventListener('input', e => { useQuickSearch(); queueSearch(e); });
quickSearchInput.addEventListener('compositionend', () => { useQuickSearch(); queueSearch(); });
quickSearchInput.addEventListener('keydown', async e => {
  if(e.isComposing) return;
  if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); clearSearch(); quickSearchInput.focus(); }
  if(e.key === 'Enter'){
    e.preventDefault(); e.stopPropagation(); clearTimeout(searchTimer);
    if(lastSearchSignature !== searchSignature()) await searchTree(searchInput.value);
    else if(matches.length) focusMatch((currentMatchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
  }
});
quickNextMatchBtn.addEventListener('click', () => {
  if(matches.length) focusMatch((currentMatchIndex + 1) % matches.length);
});
function setSearchError(message){
  searchError.hidden = !message; searchError.textContent = message;
  searchInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  quickSearchInput.title = message ? msg`${message}；按 ${shortcutText('find')} 调整查找选项` :
    Object.values(searchOptions).some(Boolean) ? msg`高级查找选项正在生效；按 ${shortcutText('find')} 调整，输入新内容恢复普通搜索` : '';
}
function searchSignature(){ return JSON.stringify([searchInput.value, searchOptions]); }
function clearSearch(){
  if(templateEditing){
    resetEditorSearch();
    searchInput.value = '';
    searchInput.focus();
    return;
  }
  resetSearchState();
  if(activeDoc()) activeDoc().searchQuery = '';
  searchInput.focus();
}
for(const [id, option] of findOptionButtons){
  const button = document.getElementById(id);
  button.addEventListener('click', () => {
    const options = templateEditing ? editorFindOptions : searchOptions;
    options[option] = !options[option];
    button.setAttribute('aria-pressed', String(options[option]));
    if(templateEditing) void searchEditorKeys();
    else { clearTimeout(searchTimer); searchTree(searchInput.value); }
    searchInput.focus();
  });
}
clearSearchBtn.addEventListener('click', clearSearch);
searchScopeBtn.addEventListener('click', () => {
  if(templateEditing) return;
  const scope = selectedSearchPath || matches[currentMatchIndex];
  if(searchOptions.scopePath === null && !scope){ showToast(t('请先点击要查找的节点')); return; }
  searchOptions.scopePath = searchOptions.scopePath === null ? [...scope] : null;
  searchScopeBtn.setAttribute('aria-pressed', String(searchOptions.scopePath !== null));
  searchScopeBtn.title = searchOptions.scopePath ? msg`查找范围：${encodePath(searchOptions.scopePath)}` : t('仅在选中节点内查找：先点击一个节点');
  tree.querySelectorAll('.search-scope-node').forEach(n => n.classList.remove('search-scope-node'));
  if(searchOptions.scopePath) for(const node of tree.querySelectorAll('.tree-node')) if(node.dataset.path === encodePath(searchOptions.scopePath)) node.classList.add('search-scope-node');
  clearTimeout(searchTimer); searchTree(searchInput.value); searchInput.focus();
});
searchInput.addEventListener('keydown', async e => {
  if(e.isComposing) return;
  if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeFindPanel(); }
  if(e.key === 'Enter'){
    e.preventDefault(); e.stopPropagation();
    if(templateEditing){
      if(editorSearchQuery !== editorSearchInput.value.trim()) await searchEditorKeys();
      else await focusEditorMatch(editorHitIndex + (e.shiftKey ? -1 : 1));
      return;
    }
    clearTimeout(searchTimer);
    if(lastSearchSignature !== searchSignature()) await searchTree(searchInput.value);
    else if(matches.length) focusMatch((currentMatchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
  }
});
function queueSearch(e){
  if(templateEditing){
    editorSearchInput.value = searchInput.value;
    queueEditorSearch(e);
    return;
  }
  quickSearchInput.value = searchInput.value;
  searchGeneration++; focusGeneration++;
  matches = []; nextMatchBtn.disabled = true; prevMatchBtn.disabled = true; setSearchError('');
  lastSearchSignature = null;
  clearTimeout(searchTimer);
  if(e?.isComposing){ setSearchCount(t('输入中…')); return; }
  if(!searchInput.value){ void searchTree(''); return; }
  setSearchCount(t('搜索中…'));
  searchTimer = setTimeout(() => searchTree(searchInput.value), 160);
}
searchInput.addEventListener('input', queueSearch);
searchInput.addEventListener('compositionend', () => queueSearch());

function clearSearchHighlights(){
  document.getElementById('ideLines').querySelectorAll('.current-match').forEach(n => n.classList.remove('current-match'));
  tree.querySelectorAll('.match,.current-match').forEach(n => n.classList.remove('match','current-match'));
}

async function searchTree(query){
  quickSearchInput.value = query;
  const generation = ++searchGeneration;
  focusGeneration++;
  lastSearchSignature = null;
  matches = [];
  currentMatchIndex = -1;
  nextMatchBtn.disabled = true;
  prevMatchBtn.disabled = true;
  setSearchError('');
  searchTruncated = false; searchCount.title = ''; quickSearchCount.title = '';
  const q = query;
  if(!q){ clearSearchHighlights(); setSearchCount(''); return; }
  try { compileSearch(q, searchOptions); }
  catch(error){ clearSearchHighlights(); setSearchCount(t('表达式无效')); setSearchError(error.message); return; }
  setSearchCount(t('搜索中…'));
  const temporarySource = ideActive ? new MemoryDataSource((activeDoc()?.ideDraft ?? activeDoc()?.text ?? '').split(/\r?\n/)) : null;
  const source = temporarySource || activeDoc()?.source;
  if(!source || !activeDoc() || activeDoc().error){ temporarySource?.dispose(); clearSearchHighlights(); setSearchCount('0'); return; }
  let result;
  try{ result = await source.search(q, {
    rootLabel: currentRootLabel, indexBase: settings.indexBase, hidden: ideActive || activeDoc()?.design ? new Set() : getHiddenSet(),
    ...searchOptions,
    ...(ideActive ? {textLines:true, scopePath:null} : {}),
    cancelled: () => generation !== searchGeneration
  }); }catch(error){
    if(generation === searchGeneration){ clearSearchHighlights(); setSearchCount(t('搜索失败')); setSearchError(error.message); }
    return;
  }finally{ temporarySource?.dispose(); }
  if(!result || generation !== searchGeneration) return;
  clearSearchHighlights();
  matches = result.hits;
  searchTruncated = result.truncated;
  lastSearchSignature = JSON.stringify([query, searchOptions]);
  if(!matches.length){ setSearchCount(t('无结果')); return; }
  nextMatchBtn.disabled = false;
  prevMatchBtn.disabled = false;
  await focusMatch(0);
}

function directChildrenContainer(node){
  return [...node.children].find(el => el.classList.contains('children'));
}

function openAncestors(node){
  let p = node.parentElement;
  while(p && p !== tree){
    if(p.classList.contains('tree-node')) p.classList.add('open');
    p = p.parentElement;
  }
}

async function focusMatch(index, select = false){
  if(ideActive){
    if(!matches.length) return;
    if(activeDoc().ideFolds?.size) { activeDoc().ideFolds.clear(); renderIdeBuffer(activeDoc()); }
    currentMatchIndex = index;
    document.getElementById('ideLines').querySelectorAll('.current-match').forEach(n => n.classList.remove('current-match'));
    const row = ideLocations.get(JSON.stringify(matches[index]));
    if(row) row.classList.add('current-match');
    const input = document.getElementById('ideInput');
    input.scrollTop = Math.max(0, (matches[index][0] || 0) * 23 * (activeDoc().ideZoom || 100) / 100 - (input.clientHeight || 400) / 2);
    syncIdeScroll();
    setSearchCount(`${index + 1} / ${matches.length}${searchTruncated ? '+' : ''}`);
    return;
  }
  expansionGeneration++;
  const generation = ++focusGeneration;
  const search = searchGeneration;
  tree.querySelectorAll('.current-match').forEach(n => n.classList.remove('current-match'));
  if(!matches.length) return;
  currentMatchIndex = index;
  let node = tree.firstElementChild;
  const path = matches[index];
  for(const key of path){
    if(!node) break;
    const loaded = await node._ensureChildren?.(key);
    if(generation !== focusGeneration || search !== searchGeneration) return;
    if(loaded === false){ node = null; break; }
    node.classList.add('open');
    node = [...(directChildrenContainer(node)?.children || [])]
      .find(child => child._path?.length === node._path.length + 1 && child._path.at(-1) === key);
  }
  if(node){
    await node._wakeViewport?.();
    if(generation !== focusGeneration || search !== searchGeneration) return;
    node.classList.add('current-match');
    openAncestors(node);
    if(select || returnFindToCanvas) selectVimNode(node);
    else requestAnimationFrame(() => { if(node.isConnected) centerNode(node); });
  }
  setSearchCount(`${index + 1} / ${matches.length}${searchTruncated ? '+' : ''}`);
  searchCount.title = searchTruncated ? t('仅列出前 1000 项匹配，请缩小搜索范围') : '';
  scheduleOverflowSweep();
}

nextMatchBtn.addEventListener('click', () => {
  if(templateEditing){ void focusEditorMatch(editorHitIndex + 1); return; }
  if(!matches.length) return;
  currentMatchIndex = (currentMatchIndex + 1) % matches.length;
  focusMatch(currentMatchIndex);
});
prevMatchBtn.addEventListener('click', () => {
  if(templateEditing){ void focusEditorMatch(editorHitIndex - 1); return; }
  if(matches.length) focusMatch((currentMatchIndex - 1 + matches.length) % matches.length);
});

expandAllBtn.addEventListener('click', () => templateEditing ? editorExpandAll() : expandAll());
collapseAllBtn.addEventListener('click', () => templateEditing ? editorCollapseAll() : collapseAll());

/* ---------- 画布平移 / 缩放（主视图与编辑器共用） ---------- */
function createCanvasView(viewportEl, worldEl, labelEl, onChange){
  const state = { x: 18, y: 16, scale: 1, dragging: false };

  function apply(){
    worldEl.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    if(labelEl) labelEl.textContent = `${Math.round(state.scale * 100)}%`;
    if(onChange) onChange(state);
  }

  function zoomAt(factor, cx, cy){
    const rect = viewportEl.getBoundingClientRect();
    if(cx === undefined){ cx = rect.width / 2; cy = rect.height / 2; }

    const wx = (cx - state.x) / state.scale;
    const wy = (cy - state.y) / state.scale;
    const next = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);

    state.x = cx - wx * next;
    state.y = cy - wy * next;
    state.scale = next;
    apply();
  }

  function reset(){
    state.x = 18;
    state.y = 16;
    state.scale = 1;
    apply();
  }

  /* 拖动平移 */
  let sx = 0, sy = 0, ox = 0, oy = 0;

  viewportEl.addEventListener('pointerdown', e => {
    /* 节点、按钮、输入控件不触发画布拖动 */
    if(e.target.closest('.node-card,.toggle,button,input,select,label')) return;
    if(viewportEl === viewport) selectCopyNode(null);
    viewportEl.focus({ preventScroll: true });

    state.dragging = true;
    sx = e.clientX; sy = e.clientY;
    ox = state.x; oy = state.y;
    viewportEl.classList.add('dragging');
    viewportEl.setPointerCapture(e.pointerId);
  });

  viewportEl.addEventListener('pointermove', e => {
    if(!state.dragging) return;
    state.x = ox + (e.clientX - sx);
    state.y = oy + (e.clientY - sy);
    apply();
  });

  const endDrag = () => {
    state.dragging = false;
    viewportEl.classList.remove('dragging');
  };
  viewportEl.addEventListener('pointerup', endDrag);
  viewportEl.addEventListener('pointercancel', endDrag);

  /* 滚轮默认平移；Ctrl/⌘ + 滚轮缩放 */
  viewportEl.addEventListener('wheel', e => {
    e.preventDefault();

    if(e.ctrlKey || e.metaKey){
      const rect = viewportEl.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.10 : 0.90, e.clientX - rect.left, e.clientY - rect.top);
    }else{
      state.x -= e.deltaX;
      state.y -= e.deltaY;
      apply();
    }
  }, {passive:false});

  return { state, apply, zoomAt, reset };
}

/* 主视图画布实例 */
const mainView = createCanvasView(viewport, world, zoomLabel, onMainViewChange);

/* 画布每次变换后记下位置，刷新时据此恢复阅读位置 */
function onMainViewChange(state){
  lastViewState = { x: state.x, y: state.y, scale: state.scale };
  scheduleSessionSave();
}

zoomInBtn.addEventListener('click', () => mainView.zoomAt(1.12));
zoomOutBtn.addEventListener('click', () => mainView.zoomAt(0.89));
resetViewBtn.addEventListener('click', () => templateEditing ? editorView.reset() : resetView());

function zoomAtCenter(factor){ mainView.zoomAt(factor); }

function resetView(){ mainView.reset(); }

function applyTransform(){ mainView.apply(); }

function centerNode(node, anchor = node){
  nodeBudget.touch(node);
  const generation = focusGeneration;
  let expected;
  const align = attempt => {
    if(!node.isConnected || generation !== focusGeneration) return;
    if(expected && (mainView.state.x !== expected.x || mainView.state.y !== expected.y)) return;
    const vp = viewport.getBoundingClientRect(), nd = anchor.getBoundingClientRect();
    mainView.state.x += (vp.left + vp.width/2) - (nd.left + nd.width/2);
    mainView.state.y += (vp.top + vp.height/2) - (nd.top + nd.height/2);
    mainView.apply(); expected = { x: mainView.state.x, y: mainView.state.y };
    // A newly visible node replaces an estimated content-visibility size.
    // Settle in the actual virtualized layout, without switching size models.
    if(attempt < 3) requestAnimationFrame(() => align(attempt + 1));
  };
  align(0);
}

/* ---------- 辅助 ---------- */
function primitiveToSearchText(value){
  if(value !== null && typeof value === 'object'){
    return Array.isArray(value) ? 'array' : 'object';
  }
  return String(value);
}

function formatPrimitive(value){
  if(value === null) return 'null';
  if(typeof value === 'string') return `"${value}"`;
  return String(value);
}

function typeClass(value){
  if(value === null) return 'type-null';
  return 'type-' + typeof value;
}

function getTypeName(value){
  if(value === null) return 'null';
  if(Array.isArray(value)) return 'Array';
  if(typeof value === 'object') return 'Object';
  return typeof value;
}

function formatBytes(bytes){
  if(!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.min(
    Math.floor(Math.log(bytes)/Math.log(1024)),
    units.length-1
  );
  const n = bytes / Math.pow(1024,i);
  return `${n.toFixed(i===0?0:2)} ${units[i]}`;
}

function clamp(v,min,max){return Math.min(max,Math.max(min,v))}

/* 防止浏览器直接打开拖入的文件 */
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

// Native startup is deferred until the reader and canvas are initialized.
document.getElementById('reopenHint').textContent = desktop
  ? t('下次启动时从原路径读取文件的最新内容。关闭此项会清除恢复记录，不会删除原文件。')
  : t('在浏览器本地保存文件副本，刷新后继续打开。关闭此项会清除副本，不会删除原文件。');
document.getElementById('cancelLoadBtn').addEventListener('click', () => {
  if(runningLoad){
    const batch = runningLoad.batch;
    for(const job of [...fileLoads]) if(job.batch === batch) cancelFileLoad(job);
  }else activeLoad?.abort();
});
function initializeShortcutHints(){
  document.getElementById('openShortcutModifier').textContent = primaryModifier;
  document.getElementById('findShortcutLabel').textContent = shortcutText('find');
  const buttons = {
    chooseBtn:['open',t('打开文件')], openAnotherBtn:['open',t('打开文件')],
    newDocBtn:['newDocument',t('新建空白文档')], newAnotherBtn:['newDocument',t('新建空白文档')],
    saveBtn:['save',t('保存修改')], saveCopyBtn:['saveCopy',t('另存为副本')],
    ctxCopy:['copyNode',t('复制节点内容')],
    undoEditBtn:['undo',t('撤销修改')], redoEditBtn:['redo',t('重做修改')], formatIdeBtn:['format',t('格式化文档')],
    collapseAllBtn:['collapseAll',t('全部收起')], settingsBtn:['settings',t('设置')],
    nextMatchBtn:['nextMatch',t('下一个匹配')], prevMatchBtn:['previousMatch',t('上一个匹配')],
    quickNextMatchBtn:['nextMatch',t('下一个匹配')],
    switchViewBtn:['switchView',t('切换树形 / IDE 视图')], editModeBtn:['editMode',t('切换编辑模式')], designModeBtn:['designMode',t('切换设计模式')],
    resetViewBtn:['resetView',t('重置视图')], aboutBtn:['about',t('关于 JSON Atlas')]
  };
  for(const [id,[action,label]] of Object.entries(buttons)) document.getElementById(id).title = msg`${label}（${shortcutText(action)}）`;
  document.getElementById('redoEditBtn').title += t('。撤销后可以重做，继续编辑会清除重做记录。');
  const help = document.getElementById('shortcutHelp');
  help.replaceChildren();
  for(const [action,label] of Object.entries({newDocument:t('新建空白文档'),open:t('打开文件'),save:t('保存'),saveCopy:t('另存为副本'),close:t('关闭当前文件'),undo:t('撤销修改'),redo:t('重做修改'),copyNode:t('复制选中节点内容'),find:t('查找'),nextMatch:t('下一个匹配'),previousMatch:t('上一个匹配'),format:t('格式化文档'),settings:t('打开设置'),switchView:t('切换树形 / IDE 视图'),editMode:t('切换树形编辑模式'),designMode:t('切换设计模式'),resetView:t('重置视图 / IDE 字号'),about:t('关于 JSON Atlas'),expandAll:t('展开全部 / 当前页'),collapseAll:t('全部收起'),nextFile:t('下一个文件'),previousFile:t('上一个文件')})){
    const name = document.createElement('dt'), value = document.createElement('dd'), keys = document.createElement('kbd');
    const alternative = shortcutAlternativeLabel(action, macPlatform);
    name.textContent = label;
    keys.textContent = alternative ? `${shortcutText(action)} / ${alternative}` : shortcutText(action);
    value.appendChild(keys); help.append(name,value);
  }
  document.querySelector('.statusbar .help').textContent = msg`空白处拖动 · 滚轮平移 · ${primaryModifier} + 滚轮缩放 · 右键节点展开/收起子树`;
}
initializeShortcutHints();
syncDocumentMenu();
installTooltips(document, window);

(async () => {
  if(!nativeRestore) restoreDesignDrafts();
  await connectDesktop(openPaths, error => showToast(t('桌面文件入口失败：') + error), action => {
    if(['valueEditDialog','designTopicDialog','discardEditDialog','deleteTopicDialog','saveConflictDialog'].some(id => document.getElementById(id).open)) return;
    if(['aboutDialog','updateDialog'].some(id => document.getElementById(id).open)
      || ['settingsMask','modalMask'].some(id => document.getElementById(id).classList.contains('open'))) return;
    if(templateEditing){
      if(action === 'find') openFindPanel();
      else if(action === 'save') editorSaveBtn.click();
      else if(action === 'reset') editorView.reset();
      return;
    }
    if(action === 'open') chooseFiles();
    else if(action === 'new-document') newBlankDocument();
    else if(action === 'close' && activeDocId) closeDoc(activeDocId);
    else if(action === 'find') openFindPanel();
    else if(action === 'reset' && activeDocId) { if(ideActive) setIdeZoom(100); else resetView(); }
    else if(action === 'settings') openSettings();
    else if(action === 'about') openAbout();
    else if(action === 'check-update') openUpdateCheck();
    else if(action === 'switch-view') switchDocumentView();
    else if(action === 'edit-mode') document.getElementById('editModeBtn').click();
    else if(action === 'design-mode') document.getElementById('designModeBtn').click();
    else if(action === 'undo-edit') document.getElementById('undoEditBtn').click();
    else if(action === 'redo-edit') document.getElementById('redoEditBtn').click();
    else if(action === 'copy-node' && !ideActive) copyNodeContent(selectedCopyNode);
    else if(action === 'save') document.getElementById('saveBtn').click();
    else if(action === 'save-copy') document.getElementById('saveCopyBtn').click();
    else if(action === 'format-json') formatIde();
  });
  if(nativeRestore){
    if(settings.lowMemoryMode){
      const keys = new Set(docs.filter(doc => doc.path).map(docKey));
      for(const file of nativeRestore.files){
        const key = filePathKey(file.path);
        if(keys.has(key)) continue;
        keys.add(key);
        const name = file.name || file.path.split(/[\\/]/).pop();
        const doc = makeDoc(name, file.size, undefined, file.kind);
        Object.assign(doc, {path:file.path, identity:key, unloaded:'restore', loadOrder:++loadSequence,
          resumeSession:nativeRestore.sessions[key]});
        docs.push(doc);
      }
      if(!activeDoc() && docs.length){
        const lastKey = typeof nativeRestore.activeKey === 'string' && filePathKey(nativeRestore.activeKey);
        const active = docs.find(doc => docKey(doc) === lastKey) || docs.at(-1);
        await activateDoc(active.id);
      }
    }else{
      await openPaths(nativeRestore.files.map(file => file.path), nativeRestore.sessions, nativeRestore.activeKey);
    }
    nativeRestore = null;
    const current = activeDoc();
    scheduleIndexVerification(current);
    for(const doc of docs) if(doc !== current) scheduleIndexVerification(doc);
    restoreDesignDrafts(false);
  }
})().catch(error => showToast(t('启动失败：') + error));
