import { pagedChildren, discardPagedTree } from './paging.js';
import { MemoryDataSource } from './data-source.js';
import { normalizeThreshold, needsIndex } from './large-files.js';
import { ViewportWindow } from './viewport-window.js';
import { NodeBudget } from './node-budget.js';
import { compileSearch } from './search-pattern.js';
import { openAbout } from './about.js';
import { MAX_FILE_BYTES, parseDocument, encodeDataPath as encodePath, normalizeDataPath as normalizePath } from './data.js';
import { desktop, readNativeFile, statNativeFile, openIndexedFile, selectNativeFiles, updateWindowTitle, connectDesktop } from './desktop.js';

let expansionGeneration = 0;
let searchTimer;
let searchGeneration = 0;
let focusGeneration = 0;
let searchTruncated = false;
let activeLoad = null;
let openQueue = Promise.resolve();


const landing = document.getElementById('landing');
const viewer = document.getElementById('viewer');
const fileInput = document.getElementById('fileInput');
const chooseBtn = document.getElementById('chooseBtn');
const dropZone = document.getElementById('dropZone');
const jsonlOpts = document.getElementById('jsonlOpts');
const jsonlHint = document.getElementById('jsonlHint');

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
let findPlacement = { x: null, y: null, pinned: false };
try {
  const saved = JSON.parse(localStorage.getItem('json-atlas_find-window_v1'));
  if(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y))
    findPlacement = { x: saved.x, y: saved.y, pinned: saved.pinned === true };
} catch { /* Ignore unavailable storage or obsolete placement. */ }
let findDrag = null;
const searchOptions = { caseSensitive: false, wholeWord: false, regex: false, scopePath: null };
const searchScopeBtn = document.getElementById('searchScopeBtn');
let selectedSearchPath = null;
let lastSearchSignature = null;

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const tree = document.getElementById('tree');
const viewportWindow = new ViewportWindow(viewport);
const pathText = document.getElementById('pathText');

const fileRail = document.getElementById('fileRail');
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
/* 文件形态提示：让用户知道本次是哪种解析路径、以及哪些设置正在生效 */
const JSONL_IDLE_HINT = 'JSON · JSONL · NDJSON';

function modeHints(){
  const bits = [];
  bits.push(settings.jsonlWrapArray !== false ? '数组根' : '首条为根');
  bits.push(settings.strictJsonl ? '严格模式（坏行即拒绝）' : '坏行跳过');
  return bits.join(' · ');
}

function noteFileMode(kind, extra){
  const on = kind === 'jsonl';
  jsonlOpts.classList.toggle('available', on);
  if(on){
    jsonlHint.textContent = (extra && extra.trim() ? extra.trim().split('\n')[0] : '已识别为 JSONL')
      + ' · ' + modeHints();
  }else{
    jsonlHint.textContent = JSONL_IDLE_HINT;
  }
  return on;
}

function clearJsonlOptions(){ noteFileMode('json'); }

/* ---------- 多文件：文档（条纹）模型 ----------
   每份打开的文件是一个文档；左侧条纹栏里一根条纹对应一个文档。
   全局镜像（parsedData / currentRootLabel）始终等于「当前激活文档」的值：
   切换时先把旧文档的阅读状态快照回去，再把新文档铺开。 */
let docs = [];
let activeDocId = null;
let docSeq = 0;

function activeDoc(){
  return docs.find(d => d.id === activeDocId) || null;
}

/* 本地存储 / 会话里用「文件名 + 体积」定位文档，不用易变的自增 id */
function docKey(doc){ return doc.identity || doc.path || `${doc.name}::${doc.size}`; }

function makeDoc(name, size, text, kind){
  return {
    id: 'doc' + (++docSeq),
    name, size, text, kind,
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
  .map(b => `  第 ${b.line} 行：${b.message}\n    ${(b.text || '').slice(0, 160)}`)
  .join('\n') + (list.length > 10 ? `\n  …另有 ${list.length - 10} 行` : '');

/* 按当前 settings 把文档折算成可渲染状态：{data, rootLabel, sub, warn} 或 {error} */
function resolveDoc(doc){
  if(doc.source?.indexed){
    const info = doc.source.info;
    if(settings.strictJsonl && info.kind === 'jsonl' && info.badCount + info.commentCount > 0){
      return { error: `严格模式下拒绝加载：${info.badCount + info.commentCount} 行不合规（含注释行）。可在设置中关闭严格模式后继续阅读。` };
    }
    const wrap = doc.source.wrap && info.records > 1;
    return { data: doc.source, rootLabel: info.kind === 'jsonl'
      ? (wrap ? `${info.records} 条记录` : info.records === 1 ? '单条记录' : '首条记录') : 'root',
      sub: ['索引模式 · 按页读取', info.kind === 'jsonl' ? `${info.records} 条记录` : '',
        info.badCount ? `${info.badCount} 行已跳过` : ''].filter(Boolean).join(' · ') };
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
      parseBad.length ? `${parseBad.length} 行 JSON 解析失败` : null,
      commentBad.length ? `${commentBad.length} 行为注释行（JSONL 规范不支持）` : null
    ].filter(Boolean).join('，');
    return { error:
      `严格模式下拒绝加载：${why}（共 ${doc.totalLines} 行）。\n` +
      `可在「设置 → JSONL」关闭严格模式以跳过这些行。\n\n` + badLinesPreview(doc.bad) };
  }

  if(!doc.records.length) return { error: doc.error || '文件内没有可解析的记录' };

  /* 非严格模式：注释行静默跳过，只有解析失败行会提示（与旧行为一致） */
  const visibleBad = parseBad;
  const wrap = doc.records.length > 1 && settings.jsonlWrapArray !== false;

  return {
    data: wrap ? doc.records : doc.records[0],
    rootLabel: wrap
      ? `${doc.records.length} 条记录`
      : (doc.records.length === 1 ? '单条记录' : '首条记录'),
    sub: [
      `JSONL · ${doc.records.length} 条记录`,
      visibleBad.length ? `${visibleBad.length} 行已跳过` : null
    ].filter(Boolean).join(' · '),
    warn: visibleBad.length
      ? `以下行不符合 JSONL，已跳过（其余 ${doc.records.length} 条正常显示）：\n` + badLinesPreview(visibleBad)
      : null
  };
}

/* 切走前把当前文档的阅读状态（展开层级 / 视图 / 搜索词）快照回文档对象。
   文档当前处于错误态时树没有渲染，保留上一次的快照不动 */
function snapshotDoc(){
  const doc = activeDoc();
  if(!doc || doc.error) return;

  doc.openPaths = [...tree.querySelectorAll('.tree-node.open')]
    .map(n => n.dataset.path);
  if(lastViewState) doc.view = { x: lastViewState.x, y: lastViewState.y, scale: lastViewState.scale };
  doc.searchQuery = searchInput.value || '';
  doc.data = parsedData;
  doc.rootLabel = currentRootLabel;
}

/* 激活某个文档：折算解析结果 → 铺到全局镜像 → 渲染 → 恢复它自己的阅读状态 */
function activateDoc(id){
  const doc = docs.find(d => d.id === id);
  if(!doc) return;

  if(activeDocId && activeDocId !== id) snapshotDoc();
  activeDocId = id;
  expansionGeneration++;
  viewportWindow.clear();
  discardPagedTree(tree);
  const oldEditor = document.getElementById('editorTree');
  discardPagedTree(oldEditor);
  document.getElementById('editorMask').classList.remove('open');
  closeModal();
  updateWindowTitle(doc.name);

  const r = resolveDoc(doc);
  doc.error = r.error || null;
  doc.sub = r.sub || '';
  if(r.data !== undefined){ doc.data = r.data; doc.rootLabel = r.rootLabel; }

  /* 当前仍保留内存解析结果；树、搜索及全文读取经 doc.source 访问。 */
  parsedData = doc.data;
  currentRootLabel = doc.rootLabel;

  noteFileMode(doc.kind, doc.sub);
  landing.style.display = 'none';
  viewer.style.display = 'flex';

  updateDocHeader(doc);
  renderRail();
  saveReopenCopy();

  /* 搜索框 / 上一次的匹配列表一律重置：命中的节点属于上一份文件 */
  resetSearchState();

  if(doc.error){
    /* 清空画布，否则上一份文件的树会留在半透明错误面板后面 */
    tree.innerHTML = '';
    tree.classList.remove('virtualized');
    renderDocError(doc);
    return;
  }
  hideDocError();

  /* 重建树：初始全收起，稍后按这份文件上次的展开状态恢复 */
  renderTree(parsedData, currentRootLabel);

  const activation = expansionGeneration;
  requestAnimationFrame(async () => {
    if(activation !== expansionGeneration) return;
    if(activeDocId !== doc.id) return;
    if(Array.isArray(doc.openPaths)){
      await expandByPaths(doc.openPaths, { exact: true });
      if(activeDocId !== doc.id || activation !== expansionGeneration) return;
      if(doc.view) applySessionView(doc.view); else resetView();
    }else{
      resetView();
      await applyOpenPolicy();
      if(activeDocId !== doc.id || activation !== expansionGeneration) return;
      if(doc.view) applySessionView(doc.view);
    }
    if(doc.searchQuery){
      searchInput.value = doc.searchQuery;
      quickSearchInput.value = doc.searchQuery;
      searchTree(doc.searchQuery);
    }
  });

  scheduleSessionSave();
}

/* 关闭某个文档：它的会话随之丢弃；关掉当前文件则自动切到相邻的一份 */
function closeDoc(id){
  const idx = docs.findIndex(d => d.id === id);
  if(idx < 0) return;

  const wasActive = id === activeDocId;
  const closing = docs[idx];
  closing.source?.dispose();

  if(wasActive) snapshotDoc();
  docs.splice(idx, 1);

  if(!docs.length){
    withdrawView();
  }else if(wasActive){
    activateDoc(docs[Math.min(idx, docs.length - 1)].id);
  }else{
    renderRail();
  }

  saveReopenCopy();
  saveSession();
  showToast(`已关闭 ${closing.name}`);
}

function updateDocHeader(doc){
  fileName.textContent = doc.name;
  fileName.title = doc.path || doc.name;

  const kindTag = doc.kind === 'jsonl' ? ' · JSONL' : '';
  const rootType = doc.source?.indexed ? doc.source.getRoot().type : null;
  const typeName = doc.error ? '无法预览' : rootType ? ({array:'Array',object:'Object'}[rootType] || rootType) : getTypeName(doc.data);
  fileSub.textContent = `${formatBytes(doc.size)} · ${typeName}${kindTag}`;
}

function resetSearchState(){
  focusGeneration++;
  clearTimeout(searchTimer);
  searchGeneration++;
  matches = [];
  currentMatchIndex = -1;
  searchInput.value = '';
  quickSearchInput.value = '';
  setSearchCount('');
  nextMatchBtn.disabled = true;
  prevMatchBtn.disabled = true;
  lastSearchSignature = null;
  searchOptions.scopePath = null; selectedSearchPath = null;
  searchScopeBtn.setAttribute('aria-pressed', 'false');
  searchScopeBtn.title = '仅在选中节点内查找：先点击一个节点';
  tree.querySelectorAll('.search-scope-node').forEach(n => n.classList.remove('search-scope-node'));
  setSearchError('');
  tree.querySelectorAll('.match,.current-match').forEach(n => n.classList.remove('match','current-match'));
  pathText.textContent = '路径：$';
}

/* ---------- 左侧条纹栏 ---------- */
function fileProblem(doc){
  const error = resolveDoc(doc).error;
  const info = doc.source?.indexed ? doc.source.info : null;
  const skipped = info ? (info.badCount || 0) + (info.commentCount || 0) : doc.bad?.length || 0;
  return { error, skipped };
}
/* 条纹信息里的一行摘要：类型 / 记录数 / 体积 */
function railMeta(doc, problem = fileProblem(doc)){
  const bits = [doc.kind === 'jsonl' ? 'JSONL' : 'JSON'];
  if(doc.kind === 'jsonl' && doc.records) bits.push(`${doc.records.length} 条记录`);
  if(problem.error) bits.push('无法预览');
  else if(problem.skipped) bits.push(`已跳过 ${problem.skipped} 行`);
  bits.push(formatBytes(doc.size));
  return bits.join(' · ');
}

function renderRail(){
  const previousScroll = fileRail.querySelectorAll('.rail-list')[0]?.scrollTop || 0;
  applyRailStyle();
  fileRail.innerHTML = '';

  /* 展开时才浮出的毛玻璃底：与文件列表分开，折叠时侧栏完全透明 */
  const glass = document.createElement('div');
  glass.className = 'rail-glass';
  fileRail.appendChild(glass);

  const list = document.createElement('div');
  list.className = 'rail-list';
  list.setAttribute('tabindex', '0');
  list.setAttribute('aria-label', '已打开的文件列表，可滚动');

  docs.forEach(doc => {
    const problem = fileProblem(doc);
    const slot = document.createElement('div');
    slot.className = 'file-slot'
      + (doc.id === activeDocId ? ' active' : '')
      + (problem.error ? ' error' : problem.skipped ? ' warning' : '');
    slot.dataset.id = doc.id;

    const tab = document.createElement('div');
    tab.className = 'file-tab';
    tab.title = `${doc.name}\n${railMeta(doc, problem)}${problem.error ? '\n' + problem.error : ''}`;
    tab.setAttribute('aria-label', `${doc.name}，${railMeta(doc, problem)}`);
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
    meta.textContent = railMeta(doc, problem);
    info.append(nm, meta);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'file-close';
    close.textContent = '✕';
    close.title = '关闭这份文件';
    close.addEventListener('click', e => {
      e.stopPropagation();
      closeDoc(doc.id);
    });

    tab.append(dot, info, close);
    tab.addEventListener('click', () => {
      if(doc.id !== activeDocId) activateDoc(doc.id);
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
  addName.textContent = '打开文件…';
  const addMeta = document.createElement('div');
  addMeta.className = 'file-tab-meta';
  addMeta.textContent = '可多选，或把文件拖进来';
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
  add.title = '打开更多文件（可多选，也可把文件拖进来）';
  add.appendChild(addTab);
  list.appendChild(add);

  fileRail.appendChild(list);
  list.scrollTop = previousScroll;
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
  label.textContent = '这份文件当前无法预览';
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
  if(doc.kind === 'jsonl' && settings.strictJsonl && doc.error?.startsWith('严格模式下拒绝加载') && (doc.source?.info?.records || doc.records?.length || 0) > 0){
    const retry = document.createElement('button');
    retry.className = 'doc-error-primary';
    retry.textContent = '关闭严格模式并重试';
    retry.addEventListener('click', () => {
      settings.strictJsonl = false;
      saveSettings();
      optStrictJsonl.checked = false;
      activateDoc(doc.id);
    });
    retryButton = retry;
  }

  const close = document.createElement('button');
  close.textContent = '关闭这份文件';
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
['dragleave','drop'].forEach(type => {
  dropZone.addEventListener(type, e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  });
});
dropZone.addEventListener('drop', e => {
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
  const files = [...fileList].filter(Boolean);
  openQueue = openQueue.then(async () => { for(const file of files) await loadFile(file); });
  return openQueue;
}

let pickingFiles = false;
async function chooseFiles(){
  if(!desktop){ fileInput.click(); return; }
  if(pickingFiles) return;
  pickingFiles = true;
  try{ await openPaths(await selectNativeFiles()); }
  catch(error){ showToast('无法选择文件：' + error); }
  finally{ pickingFiles = false; }
}

function openPaths(paths, sessions){
  openQueue = openQueue.then(async () => {
    for(const path of paths){
      await loadFile({ path }, sessions);
    }
  });
  return openQueue;
}

function parseInBackground(payload, signal){
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser.worker.js', import.meta.url), { type: 'module' });
    const finish = (error, value) => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new DOMException('已取消打开', 'AbortError'));
    if(signal.aborted){ abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data);
    worker.onerror = event => finish(new Error(event.message || '后台解析失败'));
    worker.postMessage(payload);
  });
}

async function loadFile(file, sessions){
  if(!file.path && file.size > MAX_FILE_BYTES){ showToast('当前版本支持最大 256 MiB 的文件'); return; }
  if(!file.path && !/\.(json|jsonl|ndjson|jsonlines|txt)$/i.test(file.name)){
    showToast(`已跳过 ${file.name}：不支持的文件格式`); return;
  }
  const controller = new AbortController();
  activeLoad = controller;
  loadingStatus.hidden = false;
  loadingLabel.textContent = '正在读取 ' + (file.name || file.path) + '…';
  loadingProgress.removeAttribute('value');
  let indexedSource = null;
  let attached = false;
  try{
    const metadata = file.path ? await statNativeFile(file.path) : file;
    if(controller.signal.aborted) return;
    let result, text, source = metadata;
    if(file.path && needsIndex(metadata.size, settings.largeFileThresholdMiB)){
      loadingLabel.textContent = '正在后台建立索引 · 0% · ' + metadata.name;
      indexedSource = await openIndexedFile(metadata, {
        signal: controller.signal, wrap: settings.jsonlWrapArray !== false, strict: !!settings.strictJsonl,
        progress(bytes){
          const percent = Math.min(99, Math.floor(bytes / Math.max(1, metadata.size) * 100));
          loadingProgress.value = percent;
          loadingLabel.textContent = `正在后台建立索引 · ${percent}% · ${metadata.name}`;
        }
      });
      result = { kind: indexedSource.info.kind }; text = '';
    }else{
      source = file.path ? await readNativeFile(metadata.path) : file;
      controller.signal.throwIfAborted();
      loadingLabel.textContent = '正在后台解析 ' + source.name + '…';
      ({ result, text } = await parseInBackground({
        name: source.name, size: source.size, file: file.path ? null : file,
        text: file.path ? source.text : null, keepText: !desktop
      }, controller.signal));
    }
    if(controller.signal.aborted) return;
    const doc = Object.assign(makeDoc(source.name, source.size, text, result.kind), result);
    if(indexedSource) doc.source = indexedSource;
    doc.path = source.path || null;
    // Windows paths are case insensitive; native canonical paths identify documents.
    doc.identity = doc.path && navigator.platform.startsWith('Win') ? doc.path.toLowerCase() : doc.path;
    if(doc.kind === 'jsonl') doc.bad ||= [];
    const duplicate = docs.find(d => doc.path ? docKey(d) === docKey(doc)
      : !d.path && d.name === doc.name && d.size === doc.size && d.text === doc.text);
    if(duplicate){
      duplicate.source?.dispose();
      Object.assign(duplicate, { parsed: doc.parsed, records: doc.records, bad: doc.bad,
        totalLines: doc.totalLines, text: doc.text, size: doc.size, kind: doc.kind, error: doc.error,
        rootLabel: 'root', data: undefined, source: indexedSource });
      attached = true;
      activateDoc(duplicate.id);
    }else{
      const session = sessions && sessionFor(doc, sessions);
      if(session){ doc.openPaths = session.paths; doc.view = session.view; }
      docs.push(doc);
      attached = true;
      activateDoc(doc.id);
    }
    saveReopenCopy();
  }catch(error){
    if(error.name !== 'AbortError') showToast('打开失败：' + (error.message || String(error)));
  }finally{
    if(indexedSource && !attached) indexedSource.dispose();
    if(activeLoad === controller){ activeLoad = null; loadingStatus.hidden = true; }
  }
}

/* ---------- 「刷新后继续打开」：整组文件 + 各自的阅读会话 ---------- */
/* 把已打开的文件集合写入本地，刷新后整体恢复。
   未开启该设置时不碰 localStorage；配额不足时退化为只保存当前文件 */
function saveReopenCopy(){
  if(!settings.reopenLast) return;

  if(!docs.length){
    try{
      localStorage.removeItem(LASTFILE_KEY);
      localStorage.removeItem(SESSION_KEY);
    }catch(_){}
    return;
  }

  if(desktop){
    const snapshot = { version: 3, activeKey: docKey(activeDoc() || docs[0]),
      docs: docs.filter(d => d.path).map(d => ({ path: d.path })), savedAt: Date.now() };
    try{ localStorage.setItem(LASTFILE_KEY, JSON.stringify(snapshot)); }
    catch(_){ showToast('未能保存文件列表'); }
    return;
  }

  const snapshot = active => ({
    version: 2,
    activeKey: docKey(active),
    docs: docs.map(d => ({
      name: d.name, size: d.size, kind: d.kind,
      text: d.text, rootLabel: d.rootLabel
    })),
    savedAt: Date.now()
  });

  try{
    localStorage.setItem(LASTFILE_KEY, JSON.stringify(snapshot(activeDoc() || docs[0])));
    return;
  }catch(_){}

  /* 文件太多 / 太大：退化为只保留当前文件，保证核心的「刷新后继续打开」仍可用 */
  const cur = activeDoc() || docs[0];
  try{
    localStorage.setItem(LASTFILE_KEY, JSON.stringify({
      version: 2,
      activeKey: docKey(cur),
      docs: [{ name: cur.name, size: cur.size, kind: cur.kind, text: cur.text, rootLabel: cur.rootLabel }],
      savedAt: Date.now()
    }));
    showToast('打开的文件较多，刷新后只会恢复当前文件');
  }catch(_){
    showToast('文件过大，未能保存刷新恢复副本');
  }
}

/* ---------- 阅读会话：每个文档的展开状态 + 视图位置 ---------- */
/* 只收集体积很小的会话数据；文件原文在副本里，不跟着一起重写 */
function collectSession(){
  if(!settings.reopenLast || !settings.restoreSession) return null;
  if(!docs.length) return { version: 3, docs: {}, savedAt: Date.now() };

  /* 当前文档的展开 / 平移状态先落到文档对象上，再整体收集 */
  snapshotDoc();

  const map = {};
  docs.forEach(d => {
    if(!d.openPaths && !d.view) return;
    map[docKey(d)] = { paths: d.openPaths || [], view: d.view || null };
  });
  return { version: 3, docs: map, savedAt: Date.now() };
}

/* 展开 / 平移后延迟落盘：拖动过程中不会每一帧都写 localStorage */
let sessionSaveTimer = null;
function scheduleSessionSave(){
  if(!settings.reopenLast || !settings.restoreSession) return;

  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, 400);
}

function saveSession(){
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = null;

  const session = collectSession();
  if(!session) return;

  try{ localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }catch(_){}
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
window.addEventListener('pagehide', saveSession);

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
  nodeBudget.reset(); updateNodeBudgetNotice();
  viewportWindow.clear();
  discardPagedTree(tree);
  activeDocId = null;
  docs = [];
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
function showNodeLimit(scope = tree, message = '已达到 5000 个显示节点，可精简远处内容后继续展开'){
  showToast(message);
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
  showToast(removed ? `已精简 ${removed} 个远处节点，可通过“查看此处”或搜索重新访问` : '当前没有可精简的远处未阅读节点，可手动收起部分分支');
});
tree.addEventListener('pointerdown', e => {
  const node = e.target.closest('.tree-node'); nodeBudget.touch(node);
  if(node && node._source === activeDoc()?.source) selectedSearchPath = [...node._path];
});
tree.addEventListener('focusin', e => nodeBudget.touch(e.target.closest('.tree-node')));

function updateVirtualization(){
  const n = tree.querySelectorAll('.tree-node').length;
  nodeBudget.observe(tree.querySelectorAll('.tree-node'));
  if(n >= nodeBudget.limit && !nodeBudget.warned) showNodeLimit();
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
  expandAllBtn.textContent = indexed ? '展开当前页' : '展开全部';
  expandAllBtn.title = indexed ? '展开当前页的节点，最多显示约 5000 个节点' : '展开全部节点，最多显示约 5000 个节点';
  document.getElementById('ctxExpandSubtree').textContent = indexed ? '展开当前页的下级' : '展开全部下级';
  document.getElementById('editorExpandAllBtn').textContent = indexed ? '展开当前页' : '展开全部';
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
      shell.textContent = '加载内容…'; shell.setAttribute('aria-label', '加载字段 ' + node._key);
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
        if(!descriptor) throw new Error('节点不存在');
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
          node.firstElementChild.textContent = '加载失败，点击重试';
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

  const ensureChildren = pagedChildren(node, children, source, sourcePath, item => {
    if(getHiddenSet().has(normalizePath(encodePath(path.concat(item.key))))) return null;
    return createNode(item.arrayItem ? arrayIndexLabel(item.key) : String(item.key), item,
      path.concat(item.key), false, item.arrayItem, source);
  }, () => { updateVirtualization(); scheduleOverflowSweep(); });

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
  card.addEventListener('click', toggleNode);
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
  toggle.title = '展开 / 收起该字段解析出的 JSON';

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
  btn.title = '内容超出最大高度，点击查看完整内容';
  btn.setAttribute('aria-label', '查看完整内容');

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
  btn.title = '该字段的内容是 JSON 文本，点击以 JSON 展开';
  btn.setAttribute('aria-label', '将该字段以 JSON 展开');

  btn.addEventListener('click', e => {
    e.stopPropagation();
    e.preventDefault();
    expandJsonField(node);
  });

  return btn;
}

function createNode(key, descriptor, path, isRoot=false, isArrayItem=false, source){
  const isBranch = descriptor.type === 'object' || descriptor.type === 'array';
  const value = descriptor.value;

  const node = document.createElement('div');
  node.className = 'tree-node'
    + (isBranch ? ' branch' : '')
    + (isRoot ? ' root-node' : '');
  node.dataset.path = encodePath(path);
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

  const toggle = document.createElement('button');
  toggle.className = 'toggle' + (isBranch ? '' : ' placeholder');
  toggle.innerHTML = '<span class="chevron">›</span>';

  const card = document.createElement('div');
  card.className = 'node-card';

  const keyEl = document.createElement('span');
  keyEl.className = 'node-key';
  keyEl.textContent = key;
  node._keyEl = keyEl;

  if(isBranch){
    card.appendChild(keyEl);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${descriptor.type === 'array' ? 'Array' : 'Object'} · ${descriptor.childCount}`;
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
      card.title = '长字段仅显示预览，点击 … 读取全文（上限 8 MiB）';
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
    pathText.textContent = '路径：' + node.dataset.path;
  });
  card.addEventListener('mouseleave', () => {
    pathText.textContent = '路径：$';
  });

  if(isBranch) attachChildren(node, card, toggle, source, descriptor.path, path);

  return node;
}

async function expandVisible(root, scope = tree){
  if(!root) return;
  const generation = ++expansionGeneration;
  const docId = activeDocId;
  const stack = [root];
  let visited = 0;
  while(stack.length){
    if(generation !== expansionGeneration || docId !== activeDocId || !root.isConnected) return;
    if(scope.querySelectorAll('.tree-node').length >= 5000){
      showNodeLimit(scope); break;
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
  if(scope.querySelector('.page-navigation')) showToast('已展开当前页；更多条目可在节点下翻页');
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
const ctxExpandOne = document.getElementById('ctxExpandOne');
const ctxExpandSubtreeBtn = document.getElementById('ctxExpandSubtree');
const ctxCollapseBtn = document.getElementById('ctxCollapse');
let ctxTarget = null;

/* 展开该节点的一级子节点 */
async function expandOne(node, key){
  if(!node.classList.contains('branch')) return;
  node.classList.add('open');
  await node._ensureChildren?.(key);
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
  ctxMenu.style.display = 'block';

  /* 叶子节点禁用展开项 */
  const branch = isBranchEl(ctxTarget);
  ctxExpandOne.disabled = !branch;
  ctxExpandSubtreeBtn.disabled = !branch;
  ctxCollapseBtn.disabled = !branch || !ctxTarget.classList.contains('open');

  /* 防止菜单超出窗口 */
  const mw = ctxMenu.offsetWidth;
  const mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
  ctxMenu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
}

function closeMenu(){
  ctxMenu.style.display = 'none';
}

tree.addEventListener('contextmenu', e => {
  const card = e.target.closest('.node-card');
  if(!card) return;
  e.preventDefault();
  e.stopPropagation();

  const node = card.closest('.tree-node');
  if(!node) return;
  ctxTarget = node;
  openMenu(e.clientX, e.clientY);
});

ctxExpandOne.addEventListener('click', () => {
  expansionGeneration++;
  if(ctxTarget) expandOne(ctxTarget);
  closeMenu();
});
ctxExpandSubtreeBtn.addEventListener('click', () => {
  if(ctxTarget) expandSubtree(ctxTarget);
  closeMenu();
});
ctxCollapseBtn.addEventListener('click', () => {
  if(ctxTarget) collapseSubtree(ctxTarget);
  closeMenu();
});

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
  catch(error){ if(generation === modalGeneration) showToast('读取内容失败：' + error.message); return; }
  if(generation !== modalGeneration || !node.isConnected) return;

  modalTitle.textContent = node._key;
  modalPath.textContent = node.dataset.path;
  modalBody.textContent = full.length > MODAL_TRUNCATE
    ? full.slice(0, MODAL_TRUNCATE) + '\n\n…（内容过长，弹窗内截断显示；复制仍为完整内容）'
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
  showToast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制');
});

ctxViewFull.addEventListener('click', () => {
  closeMenu();
  if(ctxTarget) openModal(ctxTarget);
});
ctxCopy.addEventListener('click', async () => {
  closeMenu();
  if(!ctxTarget) return;
  let content;
  try{ content = await nodeContentText(ctxTarget); }
  catch(error){ showToast('读取内容失败：' + error.message); return; }
  const ok = await copyText(content);
  showToast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制');
});

/* ---------- 设置 & 结构模板 ---------- */
const SETTINGS_KEY = 'json-atlas_settings_v1';
const TEMPLATE_KEY = 'json-atlas_template_v1';
const LASTFILE_KEY = 'json-atlas_lastfile_v1';
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
  largeFileThresholdMiB: 64,
  legacyTreeLayout: false,
  autoTemplate: true,
  defaultLevels: 0,
  indexBase: 0,              /* 数组索引编号起始值：0 基 / 1 基（仅影响显示） */
  reopenLast: false,
  restoreSession: true,      /* 刷新后恢复上次的阅读位置与展开状态（跟随 reopenLast 生效） */
  jsonlWrapArray: true,
  strictJsonl: false,
  limitValueHeight: false,   /* 限制字段内容的最大高度 */
  valueMaxLines: 6,          /* 最大高度（行） */
  railStyle: 'default'       /* 多文件栏样式：default 贴左侧竖条 / dial 悬浮细线 */
};
let template = null;

try{
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  if(s && typeof s === 'object') settings = Object.assign(settings, s);
}catch(_){}
settings.largeFileThresholdMiB = normalizeThreshold(settings.largeFileThresholdMiB);
try{
  const t = JSON.parse(localStorage.getItem(TEMPLATE_KEY));
  if(t && Array.isArray(t.paths)) template = t;
}catch(_){ template = null; }

function saveSettings(){
  try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }catch(_){}
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

/* 隐藏字段集合（模板.hidden） */
function getHiddenSet(){
  return new Set((template && template.hidden) || []);
}

/* 记录模板：当前所有处于展开态的节点路径（归一化后） */
function recordTemplate(){
  const root = tree.firstElementChild;
  if(!root){ showToast('请先打开文件'); return; }

  const paths = [...tree.querySelectorAll('.tree-node.open')]
    .map(n => normalizePath(n.dataset.path));

  if(!paths.length){ showToast('当前全部收起，没有可记录的层级'); return; }

  template = {
    paths,
    /* 结构模板 = 展开层级 + 隐藏字段：这里只改展开层级，保留已有的隐藏配置 */
    hidden: (template && template.hidden) || [],
    file: fileName.textContent || '',
    savedAt: Date.now()
  };
  saveTemplate();
  updateTemplateStatus();
  showToast(`模板已记录：${paths.length} 个展开节点`);
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
async function expandByPaths(paths, { exact = false } = {}){
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
      showNodeLimit(tree, '已达到 5000 个显示节点，停止恢复展开'); break;
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

    await expandOne(node, childKeys?.get(node.dataset.path));
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
      showNodeLimit(tree, '已达到 5000 个显示节点，停止默认展开'); break;
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
const optLegacyTreeLayout = document.getElementById('optLegacyTreeLayout');
const optLargeFileThreshold = document.getElementById('optLargeFileThreshold');
function syncThresholdControl(){
  optLargeFileThreshold.value = String(settings.largeFileThresholdMiB);
}
optLargeFileThreshold.addEventListener('change', () => {
  settings.largeFileThresholdMiB = normalizeThreshold(optLargeFileThreshold.value);
  syncThresholdControl(); saveSettings();
});
const optReopenLast = document.getElementById('optReopenLast');
const optRestoreSession = document.getElementById('optRestoreSession');
const exportSettingsBtn = document.getElementById('exportSettingsBtn');
const importSettingsBtn = document.getElementById('importSettingsBtn');
const settingsImportInput = document.getElementById('settingsImportInput');
const templateStatus = document.getElementById('templateStatus');
const applyTemplateBtn = document.getElementById('applyTemplateBtn');
const clearTemplateBtn = document.getElementById('clearTemplateBtn');
const recordTemplateBtn = document.getElementById('recordTemplateBtn');
const recordTemplateBtn2 = document.getElementById('recordTemplateBtn2');

function updateTemplateStatus(){
  if(template && (template.paths.length || (template.hidden && template.hidden.length))){
    const d = new Date(template.savedAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const hiddenPart = (template.hidden && template.hidden.length)
      ? ` · 隐藏 ${template.hidden.length} 个字段` : '';
    templateStatus.textContent =
      `已记录 ${template.paths.length} 个节点${hiddenPart} · ${template.file || '未知文件'} · ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    applyTemplateBtn.disabled = false;
    clearTemplateBtn.disabled = false;
  }else{
    templateStatus.textContent = '未记录';
    applyTemplateBtn.disabled = true;
    clearTemplateBtn.disabled = true;
  }
}

function openSettings(){
  syncThresholdControl();
  optLegacyTreeLayout.checked = settings.legacyTreeLayout === true;
  optAutoTemplate.checked = settings.autoTemplate;
  optDefaultLevels.value = String(settings.defaultLevels);
  optIndexBase.value = settings.indexBase === 1 ? '1' : '0';
  optRailStyle.value = settings.railStyle === 'dial' ? 'dial' : 'default';
  optReopenLast.checked = settings.reopenLast;
  optSettingsJsonlArray.checked = settings.jsonlWrapArray !== false;
  optStrictJsonl.checked = !!settings.strictJsonl;
  optLimitValueHeight.checked = !!settings.limitValueHeight;
  optValueMaxLines.value = String(settings.valueMaxLines || 6);
  optRestoreSession.checked = !!settings.restoreSession;
  syncValueHeightControls();
  syncReopenControls();
  updateTemplateStatus();
  settingsMask.classList.add('open');
}
function closeSettings(){
  settingsMask.classList.remove('open');
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
  settings.indexBase = parseInt(optIndexBase.value, 10) === 1 ? 1 : 0;
  saveSettings();
  relabelArrayIndexes(tree);
  relabelArrayIndexes(editorTree);
  showToast(settings.indexBase === 1
    ? '数组索引已改为从 1 开始'
    : '数组索引已改为从 0 开始');
});

/* 多文件栏样式：只切一个类，CSS 负责两套外观，文件列表本身不重建
   （renderRail 每次渲染时会再同步一次，避免样式与设置脱节） */
function applyRailStyle(){
  fileRail.classList.toggle('rail-dial', settings.railStyle === 'dial');
}

function applyTreeLayout(){
  for(const id of ['tree', 'editorTree']){
    document.getElementById(id).classList.toggle('legacy-tree-layout', settings.legacyTreeLayout === true);
  }
  viewportWindow.restoreAll();
  requestAnimationFrame(() => refreshValueOverflow(tree, true));
}

optLegacyTreeLayout.addEventListener('change', () => {
  settings.legacyTreeLayout = optLegacyTreeLayout.checked;
  saveSettings();
  applyTreeLayout();
});

optRailStyle.addEventListener('change', () => {
  settings.railStyle = optRailStyle.value === 'dial' ? 'dial' : 'default';
  saveSettings();
  applyRailStyle();
  showToast(settings.railStyle === 'dial'
    ? '多文件栏已切换为悬浮细线'
    : '多文件栏已切换为默认竖条');
});

/* 会话恢复依附于「刷新后继续打开」：上级关掉时联动项不可用 */
function syncReopenControls(){
  optRestoreSession.disabled = !settings.reopenLast;
}

optReopenLast.addEventListener('change', () => {
  settings.reopenLast = optReopenLast.checked;
  saveSettings();
  syncReopenControls();

  /* 关闭开关时清除已保存的文件副本与会话 */
  if(!settings.reopenLast){
    try{
      localStorage.removeItem(LASTFILE_KEY);
      localStorage.removeItem(SESSION_KEY);
    }catch(_){}
    return;
  }

  /* 打开开关时就地存一份当前状态：只等下次「打开文件」才写的话，
     已经打开的文件刷新后会消失（旧版的 bug） */
  if(docs.length){
    saveReopenCopy();
    scheduleSessionSave();   /* 当前的展开状态与视图位置也一并记下 */
    showToast('已保存当前打开的文件，刷新后会自动打开');
  }else{
    showToast(desktop ? '已开启：重启后从原路径重新打开文件' : '已开启：刷新后恢复文件副本');
  }
});

optRestoreSession.addEventListener('change', () => {
  settings.restoreSession = optRestoreSession.checked;
  saveSettings();

  if(!settings.restoreSession){
    try{ localStorage.removeItem(SESSION_KEY); }catch(_){}
    showToast('已关闭：刷新后回到默认阅读位置');
    return;
  }

  scheduleSessionSave();
  showToast('已开启：刷新后恢复阅读位置与展开的层级');
});

/* JSONL 设置：根结构 + 坏行策略。
   两者都只改 settings；若当前打开的是 JSONL，立即生效（用缓存文本重校验），无需重开文件。 */
const optSettingsJsonlArray = document.getElementById('optSettingsJsonlArray');
const optStrictJsonl = document.getElementById('optStrictJsonl');

optSettingsJsonlArray.addEventListener('change', () => {
  settings.jsonlWrapArray = optSettingsJsonlArray.checked;
  saveSettings();
  rebuildJsonlRoot();
});

optStrictJsonl.addEventListener('change', async () => {
  settings.strictJsonl = optStrictJsonl.checked;
  saveSettings();

  /* 立即对当前文件重校验：不合规就当场切成错误态，干净则原地重渲染。
     展开状态保留在同一份文档上，所以关掉严格模式后还能恢复到原来的层级。 */
  const doc = activeDoc();
  if(doc && doc.kind === 'jsonl'){
    if(doc.source?.indexed){ await rebuildJsonlRoot(); return; }
    snapshotDoc();
    activateDoc(doc.id);

    if(doc.error) showToast('当前文件存在不合规行，已按严格模式拒绝加载');
    else if(settings.strictJsonl) showToast('已按严格模式重新校验：文件全部合规');
    else showToast('已关闭严格模式：不合规行将被跳过');
    return;
  }

  showToast(settings.strictJsonl
    ? '已开启严格模式：下次打开文件时，不合规行将导致拒绝加载'
    : '已关闭严格模式：不合规行将被跳过并提示');
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
  settings.limitValueHeight = optLimitValueHeight.checked;
  saveSettings();
  syncValueHeightControls();
  applyValueHeightSetting();
  showToast(settings.limitValueHeight
    ? `已限制字段内容高度（${settings.valueMaxLines || 6} 行）`
    : '已取消字段内容高度限制');
});

optValueMaxLines.addEventListener('change', () => {
  settings.valueMaxLines = parseInt(optValueMaxLines.value, 10) || 6;
  saveSettings();
  applyValueHeightSetting();
});

/* 窗口变窄会让值换行更多：全部重测一次（防抖） */
let overflowResizeTimer = null;
window.addEventListener('resize', () => {
  viewportWindow.restoreAll();
  if(!settings.limitValueHeight) return;
  clearTimeout(overflowResizeTimer);
  overflowResizeTimer = setTimeout(() => refreshValueOverflow(tree, true), 200);
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
      if(generation !== jsonlConfigurationGeneration || activeDocId !== doc.id) return;
    } catch(error) { showToast('更新失败：' + (error.message || String(error))); return; }
  }
  activateDoc(doc.id);
}

/* ---------- 设置导入 / 导出 ---------- */
exportSettingsBtn.addEventListener('click', () => {
  const payload = {
    app: 'json-atlas',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    template
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'json-atlas-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('设置已导出');
});

importSettingsBtn.addEventListener('click', () => settingsImportInput.click());

settingsImportInput.addEventListener('change', () => {
  const file = settingsImportInput.files[0];
  settingsImportInput.value = '';
  if(!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try{
      const payload = JSON.parse(reader.result);
      if(!payload || typeof payload !== 'object') throw new Error('文件格式不正确');

      /* 兼容两种格式：完整导出包 { settings, template } 或裸设置对象 */
      const s = (payload.settings && typeof payload.settings === 'object')
        ? payload.settings : payload;

      settings = {
        largeFileThresholdMiB: normalizeThreshold(s.largeFileThresholdMiB),
        legacyTreeLayout: s.legacyTreeLayout === true,
        autoTemplate: !!s.autoTemplate,
        defaultLevels: parseInt(s.defaultLevels, 10) || 0,
        indexBase: parseInt(s.indexBase, 10) === 1 ? 1 : 0,
        reopenLast: !!s.reopenLast,
        restoreSession: s.restoreSession === undefined ? true : !!s.restoreSession,
        jsonlWrapArray: s.jsonlWrapArray === undefined ? true : !!s.jsonlWrapArray,
        strictJsonl: !!s.strictJsonl,
        limitValueHeight: !!s.limitValueHeight,
        valueMaxLines: parseInt(s.valueMaxLines, 10) || 6,
        railStyle: s.railStyle === 'dial' ? 'dial' : 'default'
      };

      if(payload.template && Array.isArray(payload.template.paths)){
        template = payload.template;
      }else if('template' in payload){
        template = null;
      }

      saveSettings();
      saveTemplate();
      openSettings();   /* 刷新面板显示 */
      if(activeDocId){
        if(activeDoc()?.source?.indexed && activeDoc().kind === 'jsonl') rebuildJsonlRoot();
        else { snapshotDoc(); activateDoc(activeDocId); }
      }
      relabelArrayIndexes(editorTree);
      if(settings.reopenLast) saveReopenCopy();
      else{
        try{
          localStorage.removeItem(LASTFILE_KEY);
          localStorage.removeItem(SESSION_KEY);
        }catch(_){}
      }
      applyValueHeightSetting();   /* 高度限制可能变了，立即生效 */
      applyRailStyle();   /* 多文件栏样式可能变了，立即生效 */
      applyTreeLayout();
      showToast('设置已导入');
    }catch(err){
      showToast('导入失败：' + err.message);
    }
  };
  reader.onerror = () => showToast('文件读取失败');
  reader.readAsText(file, 'utf-8');
});

/* 启动时先应用两项与显示相关的设置，避免渲染完再变化的跳动 / 联动项状态不对 */
applyValueHeightSetting();
syncReopenControls();
applyTreeLayout();

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
    nativeRestore = { paths: list.map(item => item.path).filter(Boolean), sessions, activeKey: rec.activeKey };
    return;
  }

  list.forEach(item => {
    if(!item || typeof item.text !== 'string' || !item.name) return;

    const size = Number(item.size) || new Blob([item.text]).size;
    const doc = buildDoc(item.text, item.name, size);
    if(item.rootLabel) doc.rootLabel = item.rootLabel;

    const s = sessionFor(doc, sessions);
    if(s){
      if(Array.isArray(s.paths)) doc.openPaths = s.paths;
      if(s.view) doc.view = s.view;
    }
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
    showToast('模板已应用');
  }else{
    showToast('模板未命中任何节点（结构可能不一致）');
  }
});

clearTemplateBtn.addEventListener('click', () => {
  template = null;
  try{ localStorage.removeItem(TEMPLATE_KEY); }catch(_){}
  updateTemplateStatus();
  /* 就地重建当前文档：模板隐藏掉的字段要当场恢复显示，而不是等下次切文件 */
  if(activeDocId){ snapshotDoc(); activateDoc(activeDocId); }
  showToast('模板已清除');
});

/* ---------- 结构模板编辑器（思维导图画布模式） ---------- */
const editorMask = document.getElementById('editorMask');
const editorClose = document.getElementById('editorClose');
const editorBtn = document.getElementById('editorBtn');
const editorTree = document.getElementById('editorTree');
const editorViewport = document.getElementById('editorViewport');
const editorWorld = document.getElementById('editorWorld');
const editorCount = document.getElementById('editorCount');
const editorShowAllBtn = document.getElementById('editorShowAllBtn');
const editorSaveBtn = document.getElementById('editorSaveBtn');
const editorExpandAllBtn = document.getElementById('editorExpandAllBtn');
const editorCollapseAllBtn = document.getElementById('editorCollapseAllBtn');
const editorZoomInBtn = document.getElementById('editorZoomInBtn');
const editorZoomOutBtn = document.getElementById('editorZoomOutBtn');
const editorZoomLabel = document.getElementById('editorZoomLabel');

const editorView = createCanvasView(editorViewport, editorWorld, editorZoomLabel);

/* 编辑器工作副本：打开时从模板拷贝，保存时写回 */
let editorHidden = new Set();

function openEditor(){
  /* 用文档而不是 parsedData 判断：根值是 null / false / 0 也是合法数据 */
  const doc = activeDoc();
  if(!doc || doc.error){ showToast('请先打开文件'); return; }
  editorHidden = new Set((template && template.hidden) || []);
  renderEditorTree();
  editorView.reset();
  editorMask.classList.add('open');
}

function closeEditor(){
  expansionGeneration++;
  discardPagedTree(editorTree);
  editorMask.classList.remove('open');
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
    ? `${editorHidden.size} 个字段将隐藏`
    : '全部字段显示';
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
  node._childrenType = descriptor.type;
  node._isArrayItem = isArrayItem;   /* 数组元素：序号标签可随设置实时切换 */

  const main = document.createElement('div');
  main.className = 'node-main';

  const toggle = document.createElement('button');
  toggle.className = 'toggle' + (isBranch ? '' : ' placeholder');
  toggle.innerHTML = '<span class="chevron">›</span>';

  const card = document.createElement('div');
  card.className = 'node-card ed-card';

  /* 可见性勾选框 */
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'ed-check';
  cb.checked = !editorHidden.has(normPath);
  cb.disabled = isRoot;   /* 根节点不可隐藏 */
  cb.title = isRoot ? '根节点不可隐藏' : '取消勾选将在主视图中隐藏该字段及其子级';
  cb.addEventListener('click', e => e.stopPropagation());
  cb.addEventListener('change', () => {
    if(cb.checked) editorHidden.delete(normPath);
    else editorHidden.add(normPath);
    card.classList.toggle('hidden-field', !cb.checked);
    updateEditorCount();
  });
  if(!cb.checked) card.classList.add('hidden-field');
  card.appendChild(cb);

  /* 「隐藏」标签：显示与否由 .hidden-field 类通过 CSS 控制 */
  const hideTag = document.createElement('span');
  hideTag.className = 'ed-hidden-tag';
  hideTag.textContent = '隐藏';
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
      hint.textContent = '仅第一项结构';
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
editorClose.addEventListener('click', closeEditor);
editorMask.addEventListener('click', e => {
  if(e.target === editorMask) closeEditor();
});
editorExpandAllBtn.addEventListener('click', editorExpandAll);
editorCollapseAllBtn.addEventListener('click', editorCollapseAll);
editorZoomInBtn.addEventListener('click', () => editorView.zoomAt(1.12));
editorZoomOutBtn.addEventListener('click', () => editorView.zoomAt(0.89));

editorShowAllBtn.addEventListener('click', () => {
  editorHidden.clear();
  renderEditorTree();
});

editorSaveBtn.addEventListener('click', async () => {
  template = {
    paths: (template && template.paths) || [],
    hidden: [...editorHidden],
    file: fileName.textContent || '',
    savedAt: Date.now()
  };
  saveTemplate();
  updateTemplateStatus();
  closeEditor();

  /* 重渲染主视图，隐藏字段立即生效 */
  renderTree(parsedData, currentRootLabel);
  const focusNode = await applyOpenPolicy();
  if(!focusNode) resetView();

  showToast(editorHidden.size
    ? `已应用：隐藏 ${editorHidden.size} 个字段`
    : '已应用：全部字段显示');
});

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
document.addEventListener('keydown', e => {
  if(document.getElementById('aboutDialog').open) return;
  const modifier = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if(modifier && key === 'o'){ e.preventDefault(); chooseFiles(); return; }
  if(modifier && key === 'f' && activeDoc()){ e.preventDefault(); openFindPanel(); return; }
  if(modifier && key === 'w' && activeDoc() && !e.target.closest('input,textarea,[contenteditable]')){
    e.preventDefault(); closeDoc(activeDocId); return;
  }
  if(e.key === 'F3' && matches.length){
    e.preventDefault(); focusMatch((currentMatchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length); return;
  }
  if(e.key === 'Escape'){
    if(!findPanel.hidden){ e.preventDefault(); closeFindPanel(); return; }
    clearTimeout(searchTimer);
    expansionGeneration++;
    searchGeneration++;
    if(searchCount.textContent === '搜索中…') setSearchCount('已取消');
    if(activeLoad) activeLoad.abort();
    closeMenu();
    closeModal();
    closeSettings();
    closeEditor();
  }
});

/* ---------- 搜索 ---------- */
function saveFindPlacement(){
  try { localStorage.setItem('json-atlas_find-window_v1', JSON.stringify(findPlacement)); } catch { /* Optional preference. */ }
}
function positionFindPanel(x = findPlacement.x, y = findPlacement.y){
  if(findPanel.hidden) return;
  const rect = findPanel.getBoundingClientRect();
  const width = window.innerWidth, height = window.innerHeight;
  const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  findPlacement.x = clamp(x ?? width - rect.width - 16, 12, Math.max(12, width - rect.width - 12));
  findPlacement.y = clamp(y ?? toolbarBottom + 12, 12, Math.max(12, height - rect.height - 12));
  findPanel.style.left = `${findPlacement.x}px`;
  findPanel.style.top = `${findPlacement.y}px`;
}
function updateFindPin(){
  findPanel.dataset.pinned = String(findPlacement.pinned);
  pinFindBtn.setAttribute('aria-pressed', String(findPlacement.pinned));
  pinFindBtn.title = findPlacement.pinned ? '取消固定后可拖动窗口' : '锁定窗口当前位置';
  pinFindBtn.setAttribute('aria-label', findPlacement.pinned ? '取消固定' : '固定位置');
}
function openFindPanel(){
  if(!activeDoc()) return;
  closeMoreMenu();
  findPanel.hidden = false;
  updateFindPin();
  positionFindPanel();
  searchInput.focus(); searchInput.select();
}
function closeFindPanel(restoreFocus = true){
  findPanel.hidden = true;
  findDrag = null;
  saveFindPlacement();
  if(restoreFocus) quickSearchInput.focus();
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
  positionFindPanel();
  findDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: findPlacement.x, top: findPlacement.y };
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
  e.preventDefault(); positionFindPanel(findPlacement.x + delta[0], findPlacement.y + delta[1]); saveFindPlacement();
});
window.addEventListener('resize', () => { positionFindPanel(); saveFindPlacement(); });
if(typeof ResizeObserver !== 'undefined') new ResizeObserver(() => positionFindPanel()).observe(findPanel);
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
  for(const [id, option] of [['searchCaseBtn','caseSensitive'],['searchWordBtn','wholeWord'],['searchRegexBtn','regex']]){
    searchOptions[option] = false; document.getElementById(id).setAttribute('aria-pressed', 'false');
  }
  searchOptions.scopePath = null;
  searchScopeBtn.setAttribute('aria-pressed', 'false');
  searchScopeBtn.title = '仅在选中节点内查找：先点击一个节点';
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
  quickSearchInput.title = message ? `${message}；按 Ctrl/⌘+F 调整查找选项` :
    Object.values(searchOptions).some(Boolean) ? '高级查找选项正在生效；按 Ctrl/⌘+F 调整，输入新内容恢复普通搜索' : '';
}
function searchSignature(){ return JSON.stringify([searchInput.value, searchOptions]); }
function clearSearch(){
  resetSearchState();
  if(activeDoc()) activeDoc().searchQuery = '';
  searchInput.focus();
}
for(const [id, option] of [['searchCaseBtn','caseSensitive'],['searchWordBtn','wholeWord'],['searchRegexBtn','regex']]){
  const button = document.getElementById(id);
  button.addEventListener('click', () => {
    searchOptions[option] = !searchOptions[option];
    button.setAttribute('aria-pressed', String(searchOptions[option]));
    clearTimeout(searchTimer); searchTree(searchInput.value); searchInput.focus();
  });
}
clearSearchBtn.addEventListener('click', clearSearch);
searchScopeBtn.addEventListener('click', () => {
  const scope = selectedSearchPath || matches[currentMatchIndex];
  if(searchOptions.scopePath === null && !scope){ showToast('请先点击要查找的节点'); return; }
  searchOptions.scopePath = searchOptions.scopePath === null ? [...scope] : null;
  searchScopeBtn.setAttribute('aria-pressed', String(searchOptions.scopePath !== null));
  searchScopeBtn.title = searchOptions.scopePath ? `查找范围：${encodePath(searchOptions.scopePath)}` : '仅在选中节点内查找：先点击一个节点';
  tree.querySelectorAll('.search-scope-node').forEach(n => n.classList.remove('search-scope-node'));
  if(searchOptions.scopePath) for(const node of tree.querySelectorAll('.tree-node')) if(node.dataset.path === encodePath(searchOptions.scopePath)) node.classList.add('search-scope-node');
  clearTimeout(searchTimer); searchTree(searchInput.value); searchInput.focus();
});
searchInput.addEventListener('keydown', async e => {
  if(e.isComposing) return;
  if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeFindPanel(); }
  if(e.key === 'Enter'){
    e.preventDefault(); e.stopPropagation(); clearTimeout(searchTimer);
    if(lastSearchSignature !== searchSignature()) await searchTree(searchInput.value);
    else if(matches.length) focusMatch((currentMatchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
  }
});
function queueSearch(e){
  quickSearchInput.value = searchInput.value;
  searchGeneration++; focusGeneration++;
  matches = []; nextMatchBtn.disabled = true; prevMatchBtn.disabled = true; setSearchError('');
  quickNextMatchBtn.disabled = true;
  clearTimeout(searchTimer);
  if(e?.isComposing) return;
  searchTimer = setTimeout(() => searchTree(searchInput.value), 160);
}
searchInput.addEventListener('input', queueSearch);
searchInput.addEventListener('compositionend', () => queueSearch());

async function searchTree(query){
  quickSearchInput.value = query;
  const generation = ++searchGeneration;
  tree.querySelectorAll('.match,.current-match').forEach(n => n.classList.remove('match','current-match'));
  matches = [];
  currentMatchIndex = -1;
  nextMatchBtn.disabled = true;
  prevMatchBtn.disabled = true;
  setSearchError('');
  const q = query;
  if(!q){ setSearchCount(''); return; }
  try { compileSearch(q, searchOptions); }
  catch(error){ setSearchCount('表达式无效'); setSearchError(error.message); return; }
  setSearchCount('搜索中…');
  const source = activeDoc()?.source;
  if(!source || activeDoc().error){ setSearchCount('0'); return; }
  let result;
  try{ result = await source.search(q, {
    rootLabel: currentRootLabel, indexBase: settings.indexBase, hidden: getHiddenSet(),
    ...searchOptions,
    cancelled: () => generation !== searchGeneration
  }); }catch(error){
    if(generation === searchGeneration){ setSearchCount('搜索失败'); setSearchError(error.message); }
    return;
  }
  if(!result || generation !== searchGeneration) return;
  matches = result.hits;
  searchTruncated = result.truncated;
  lastSearchSignature = JSON.stringify([query, searchOptions]);
  if(!matches.length){ setSearchCount('无结果'); return; }
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

async function focusMatch(index){
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
    if(loaded === false || generation !== focusGeneration || search !== searchGeneration) return;
    node.classList.add('open');
    node = [...(directChildrenContainer(node)?.children || [])]
      .find(child => child._path?.length === node._path.length + 1 && child._path.at(-1) === key);
  }
  if(node){
    await node._wakeViewport?.();
    if(generation !== focusGeneration || search !== searchGeneration) return;
    node.classList.add('current-match');
    openAncestors(node);
    requestAnimationFrame(() => { if(node.isConnected) centerNode(node); });
  }
  setSearchCount(`${index + 1} / ${matches.length}${searchTruncated ? '+' : ''}`);
  searchCount.title = searchTruncated ? '仅列出前 1000 项匹配，请缩小搜索范围' : '';
  scheduleOverflowSweep();
}

nextMatchBtn.addEventListener('click', () => {
  if(!matches.length) return;
  currentMatchIndex = (currentMatchIndex + 1) % matches.length;
  focusMatch(currentMatchIndex);
});
prevMatchBtn.addEventListener('click', () => {
  if(matches.length) focusMatch((currentMatchIndex - 1 + matches.length) % matches.length);
});

expandAllBtn.addEventListener('click', expandAll);
collapseAllBtn.addEventListener('click', collapseAll);

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
resetViewBtn.addEventListener('click', resetView);

function zoomAtCenter(factor){ mainView.zoomAt(factor); }

function resetView(){ mainView.reset(); }

function applyTransform(){ mainView.apply(); }

function centerNode(node){
  nodeBudget.touch(node);
  const generation = focusGeneration;
  let expected;
  const align = attempt => {
    if(!node.isConnected || generation !== focusGeneration) return;
    if(expected && (mainView.state.x !== expected.x || mainView.state.y !== expected.y)) return;
    const vp = viewport.getBoundingClientRect(), nd = node.getBoundingClientRect();
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
  if(bytes === 0) return '0 B';
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
const loadingStatus = document.getElementById('loadingStatus');
const loadingLabel = document.getElementById('loadingLabel');
const loadingProgress = document.getElementById('loadingProgress');
document.getElementById('reopenHint').textContent = desktop
  ? '下次启动时从原路径读取文件的最新内容。关闭此项会清除恢复记录，不会删除原文件。'
  : '在浏览器本地保存文件副本，刷新后继续打开。关闭此项会清除副本，不会删除原文件。';
document.getElementById('cancelLoadBtn').addEventListener('click', () => activeLoad?.abort());
(async () => {
  if(nativeRestore){
    await openPaths(nativeRestore.paths, nativeRestore.sessions);
    const active = docs.find(d => docKey(d) === nativeRestore.activeKey);
    if(active) activateDoc(active.id);
  }
  await connectDesktop(openPaths, error => showToast('桌面文件入口失败：' + error), action => {
    if(action === 'open') chooseFiles();
    else if(action === 'close' && activeDocId) closeDoc(activeDocId);
    else if(action === 'find') openFindPanel();
    else if(action === 'reset' && activeDocId) resetView();
    else if(action === 'settings') openSettings();
    else if(action === 'about') openAbout();
  });
})().catch(error => showToast('启动失败：' + error));
