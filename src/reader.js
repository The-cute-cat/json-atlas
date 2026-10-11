import { pagedChildren } from './paging.js';
import { MAX_FILE_BYTES, searchData } from './data.js';
import { desktop, readNativeFile, selectNativeFiles, updateWindowTitle, connectDesktop } from './desktop.js';

let expansionGeneration = 0;
let searchTimer;
let searchGeneration = 0;
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
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');

const viewport = document.getElementById('viewport');
const world = document.getElementById('world');
const tree = document.getElementById('tree');
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
const JSONL_EXT = /\.(jsonl|ndjson|jsonlines)$/i;
const JSON_EXT = /\.json$/i;

/* 探测文件形态：扩展名优先；必要时看内容（JSONL 一定以 { 或 [ 的单行开头） */
function detectFileKind(name, text){
  if(JSONL_EXT.test(name)) return 'jsonl';
  if(JSON_EXT.test(name)) return 'json';
  const head = text.replace(/^\uFEFF/, '').trimStart().slice(0, 4096);
  /* 内容像 JSONL：首行是完整的 {…} 或 […] 且文件能按行解析 */
  if(/^\{[^\n]*\}\s*(\n|$)/.test(head) || /^\[[^\n]*\]\s*(\n|$)/.test(head)) return 'jsonl';
  return 'json';
}

/* JSONL：逐行解析。
   - 空行始终跳过（不视为数据，也不视为违规）
   - `#` / `//` 注释行：默认模式下静默跳过；strict=true 时记为违规
   - 非空且解析失败的行：始终记为违规
   strict 只影响「哪些行算违规」，调用方据此决定是拒绝整文件还是跳过并提示。 */
function parseJsonl(text, opts = {}){
  const strict = !!opts.strict;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const records = [];
  const bad = [];
  const lineNoOf = [];

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if(!line) return;   /* 空行豁免 */

    const isComment = line.startsWith('#') || line.startsWith('//');
    if(isComment){
      /* 严格模式：JSONL 规范不含注释，静默放行会让文件「看起来完整」 */
      if(strict) bad.push({ line: i + 1, text: raw, comment: true, message: 'JSONL 规范不支持注释行（严格模式）' });
      return;
    }

    try{
      records.push(JSON.parse(line));
      lineNoOf.push(i + 1);
    }catch(err){
      bad.push({ line: i + 1, text: raw, message: err.message });
    }
  });

  return {
    records,
    bad,
    totalLines: lines.length,
    skipped: lines.length - records.length - bad.length,
    lineNoOf
  };
}

/* 文件形态提示：让用户知道本次是哪种解析路径、以及哪些设置正在生效 */
const JSONL_IDLE_HINT = '支持 .json / .jsonl / .ndjson · JSONL 的根结构与坏行处理可在「设置」中配置';

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
    openPaths: null,     /* 展开的节点路径（归一化），切走时快照 */
    searchQuery: ''      /* 这份文件上次的搜索词 */
  };
}

/* 文本 → 文档。解析失败不抛错，而是记进 doc.error：
   条纹栏里仍能看到这个文件，也便于关掉严格模式后再试一次 */
function buildDoc(text, name, size){
  text = text.replace(/^\uFEFF/, '');
  const kind = detectFileKind(name, text);
  const doc = makeDoc(name, size, text, kind);

  if(kind === 'jsonl'){
    fillJsonlDoc(doc);
    return doc;
  }

  try{
    doc.parsed = JSON.parse(text);
    return doc;
  }catch(err){
    /* .json 解析失败时再按 JSONL 试一次（扩展名是 .json 但实际是 NDJSON 很常见） */
    const probe = parseJsonl(text, { strict: true });
    if(probe.records.length){
      doc.kind = 'jsonl';
      fillJsonlDoc(doc, probe);
      return doc;
    }
    doc.error = 'JSON 解析失败：\n' + err.message;
    return doc;
  }
}

function fillJsonlDoc(doc, parsed){
  const res = parsed || parseJsonl(doc.text, { strict: true });
  doc.records = res.records;
  doc.bad = res.bad;
  doc.totalLines = res.totalLines;

  if(!res.records.length){
    doc.error = 'JSONL 解析失败：\n' + (res.bad.length
      ? `共 ${res.bad.length} 行解析失败，首个错误在第 ${res.bad[0].line} 行：${res.bad[0].message}`
      : '文件内没有可解析的记录');
  }
}

const badLinesPreview = list => list.slice(0, 10)
  .map(b => `  第 ${b.line} 行：${b.message}\n    ${(b.text || '').slice(0, 160)}`)
  .join('\n') + (list.length > 10 ? `\n  …另有 ${list.length - 10} 行` : '');

/* 按当前 settings 把文档折算成可渲染状态：{data, rootLabel, sub, warn} 或 {error} */
function resolveDoc(doc){
  if(doc.kind !== 'jsonl'){
    if(doc.error) return { error: doc.error };
    return { data: doc.parsed, rootLabel: doc.rootLabel || 'root', sub: '' };
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
    .map(n => normalizePath(n.dataset.path));
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
  updateWindowTitle(doc.name);

  const r = resolveDoc(doc);
  doc.error = r.error || null;
  doc.sub = r.sub || '';
  if(r.data !== undefined){ doc.data = r.data; doc.rootLabel = r.rootLabel; }

  /* 全局镜像：渲染 / 搜索 / 模板编辑器都读这两个变量 */
  parsedData = doc.data;
  currentRootLabel = doc.rootLabel;

  noteFileMode(doc.kind, doc.sub);
  landing.style.display = 'none';
  viewer.style.display = 'flex';

  updateDocHeader(doc);
  renderRail();

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

  requestAnimationFrame(() => {
    if(activeDocId !== doc.id) return;
    if(doc.openPaths && doc.openPaths.length){
      expandByPaths(doc.openPaths);
      if(doc.view) applySessionView(doc.view); else resetView();
    }else{
      resetView();
      applyOpenPolicy();
    }
    if(doc.searchQuery){
      searchInput.value = doc.searchQuery;
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
  const typeName = doc.error ? '无法预览' : getTypeName(doc.data);
  fileSub.textContent = `${formatBytes(doc.size)} · ${typeName}${kindTag}`;
}

function resetSearchState(){
  clearTimeout(searchTimer);
  searchGeneration++;
  matches = [];
  currentMatchIndex = -1;
  searchInput.value = '';
  searchCount.textContent = '';
  nextMatchBtn.disabled = true;
  pathText.textContent = '路径：$';
}

/* ---------- 左侧条纹栏 ---------- */
/* 条纹信息里的一行摘要：类型 / 记录数 / 体积 */
function railMeta(doc){
  const bits = [doc.kind === 'jsonl' ? 'JSONL' : 'JSON'];
  if(doc.kind === 'jsonl' && doc.records) bits.push(`${doc.records.length} 条记录`);
  if(doc.error) bits.push('无法预览');
  bits.push(formatBytes(doc.size));
  return bits.join(' · ');
}

function renderRail(){
  applyRailStyle();
  fileRail.innerHTML = '';

  /* 展开时才浮出的毛玻璃底：与文件列表分开，折叠时侧栏完全透明 */
  const glass = document.createElement('div');
  glass.className = 'rail-glass';
  fileRail.appendChild(glass);

  const list = document.createElement('div');
  list.className = 'rail-list';

  docs.forEach(doc => {
    const slot = document.createElement('div');
    slot.className = 'file-slot'
      + (doc.id === activeDocId ? ' active' : '')
      + (doc.error ? ' error' : '');
    slot.dataset.id = doc.id;

    const tab = document.createElement('div');
    tab.className = 'file-tab';
    tab.title = `${doc.name}\n${railMeta(doc)}`;

    const dot = document.createElement('span');
    dot.className = 'file-dot';

    const info = document.createElement('div');
    info.className = 'file-info';
    const nm = document.createElement('div');
    nm.className = 'file-tab-name';
    nm.textContent = doc.name;
    const meta = document.createElement('div');
    meta.className = 'file-tab-meta';
    meta.textContent = railMeta(doc);
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
}

/* ---------- 文档错误面板 ---------- */
function renderDocError(doc){
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

  /* 严格模式是唯一能让「被拒绝」的 JSONL 重新可读的设置，给一个就地开关 */
  if(doc.kind === 'jsonl' && settings.strictJsonl){
    const retry = document.createElement('button');
    retry.className = 'primary';
    retry.textContent = '关闭严格模式并重试';
    retry.addEventListener('click', () => {
      settings.strictJsonl = false;
      saveSettings();
      optStrictJsonl.checked = false;
      activateDoc(doc.id);
    });
    actions.appendChild(retry);
  }

  const close = document.createElement('button');
  close.textContent = '关闭这份文件';
  close.addEventListener('click', () => closeDoc(doc.id));
  actions.appendChild(close);

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
  if(e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
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
  try{
    const source = file.path ? await readNativeFile(file.path) : file;
    if(controller.signal.aborted) return;
    loadingLabel.textContent = '正在后台解析 ' + source.name + '…';
    const { result, text } = await parseInBackground({
      name: source.name, size: source.size, file: file.path ? null : file,
      text: file.path ? source.text : null, keepText: !desktop
    }, controller.signal);
    if(controller.signal.aborted) return;
    const doc = Object.assign(makeDoc(source.name, source.size, text, result.kind), result);
    doc.path = source.path || null;
    // Windows paths are case insensitive; native canonical paths identify documents.
    doc.identity = doc.path && navigator.platform.startsWith('Win') ? doc.path.toLowerCase() : doc.path;
    if(doc.kind === 'jsonl') doc.bad ||= [];
    const duplicate = docs.find(d => doc.path ? docKey(d) === docKey(doc)
      : !d.path && d.name === doc.name && d.size === doc.size && d.text === doc.text);
    if(duplicate){
      Object.assign(duplicate, { parsed: doc.parsed, records: doc.records, bad: doc.bad,
        totalLines: doc.totalLines, text: doc.text, size: doc.size, kind: doc.kind, error: doc.error });
      activateDoc(duplicate.id);
    }else{
      const session = sessions && sessionFor(doc, sessions);
      if(session){ doc.openPaths = session.paths; doc.view = session.view; }
      docs.push(doc);
      activateDoc(doc.id);
    }
    saveReopenCopy();
  }catch(error){
    if(error.name !== 'AbortError') showToast('打开失败：' + (error.message || String(error)));
  }finally{
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
  if(!docs.length) return { version: 2, docs: {}, savedAt: Date.now() };

  /* 当前文档的展开 / 平移状态先落到文档对象上，再整体收集 */
  snapshotDoc();

  const map = {};
  docs.forEach(d => {
    if(!d.openPaths && !d.view) return;
    map[docKey(d)] = { paths: d.openPaths || [], view: d.view || null };
  });
  return { version: 2, docs: map, savedAt: Date.now() };
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
function applyOpenPolicy(){
  let focusNode = null;

  if(settings.autoTemplate && template && template.paths.length){
    focusNode = applyTemplate();
  }else if(settings.defaultLevels > 0){
    expandLevels(tree.firstElementChild, settings.defaultLevels);
  }
  if(focusNode) requestAnimationFrame(() => centerNode(focusNode));
  return focusNode;
}

/* 撤回阅读器视图，回到落地页（关掉最后一份文件时用） */
function withdrawView(){
  activeDocId = null;
  docs = [];
  parsedData = null;
  currentRootLabel = 'root';
  updateWindowTitle(null);
  tree.innerHTML = '';
  renderRail();
  hideDocError();
  resetSearchState();
  viewer.style.display = 'none';
  landing.style.display = 'grid';
}

/* ---------- 树渲染 ---------- */
function renderTree(data, rootLabel){
  tree.innerHTML = '';
  const root = createNode(rootLabel || 'root', data, [], true);
  tree.appendChild(root);

  /* 初始全部收起，只显示根节点 */
  root.classList.remove('open');

  updateVirtualization();
  scheduleOverflowSweep();
}

/* ---------- 虚拟化开关（方案A） ----------
   节点超过阈值才开启 content-visibility，
   小文件保持精确渲染，大文件换取平移流畅 */
const CV_THRESHOLD = 1500;

function updateVirtualization(){
  const n = tree.querySelectorAll('.tree-node').length;
  tree.classList.toggle('virtualized', n > CV_THRESHOLD);
  scheduleSessionSave();   /* 树的结构变了：展开状态要记进会话 */
}

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
function attachChildren(node, card, toggle, value, path){
  const children = document.createElement('div');
  children.className = 'children';
  node.appendChild(children);

  const ensureChildren = pagedChildren(node, children, value, (childKey, childValue, isArr) => {
    if(getHiddenSet().has(normalizePath(encodePath(path.concat(childKey))))) return null;
    return createNode(isArr ? arrayIndexLabel(childKey) : String(childKey), childValue,
      path.concat(childKey), false, isArr);
  }, () => { updateVirtualization(); scheduleOverflowSweep(); });

  const toggleNode = e => {
    e.stopPropagation();
    if(!node.classList.contains('open')) ensureChildren();
    node.classList.toggle('open');
    if(!node.classList.contains('open')) node._discardChildren?.();
    updateVirtualization();
    scheduleOverflowSweep();
  };

  toggle.addEventListener('click', toggleNode);
  card.addEventListener('click', toggleNode);
}

/* 把「内容是 JSON 文本」的叶子升级成可展开的分支：
   _value 仍是原始字符串（复制 / 查看完整内容不变），子树用解析后的值渲染 */
function buildJsonChildren(node){
  const parsed = node._jsonValue;
  if(parsed === undefined || node._jsonTreeReady) return;

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

  attachChildren(node, card, toggle, parsed, node._path || []);
  updateVirtualization();
}

/* 角标点击：首次点击构造 JSON 子树，之后与 chevron 一致地展开 / 收起 */
function expandJsonField(node){
  if(!node._jsonTreeReady) buildJsonChildren(node);
  if(!node._jsonTreeReady) return;

  if(!node.classList.contains('open')) node._ensureChildren?.();
  node.classList.toggle('open');
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
    if(card && (force || !card._ovMeasured)) pending.push([el, card]);
  }
  if(!pending.length) return;

  /* 虚拟化时屏外子树没有真实布局，测量前临时全量渲染（与 centerNode 同一手法） */
  const wasVirt = tree.classList.contains('virtualized');
  if(wasVirt) tree.classList.add('no-cv');

  for(const [el, card] of pending){
    if(!el.offsetParent) continue;   /* 收起节点里的值量不了，留给下次 */

    card._ovMeasured = true;
    setFullViewIcon(card, el.scrollHeight - el.clientHeight > 1);
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

function createNode(key, value, path, isRoot=false, isArrayItem=false){
  const isBranch = value !== null && typeof value === 'object';

  const node = document.createElement('div');
  node.className = 'tree-node'
    + (isBranch ? ' branch' : '')
    + (isRoot ? ' root-node' : '');
  node.dataset.path = encodePath(path);
  node.dataset.searchText =
    `${String(key)} ${primitiveToSearchText(value)}`.toLowerCase();
  /* 保留原始值，供弹窗/复制使用；路径供 JSON 展开时拼接子节点用 */
  node._value = value;
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
  card.appendChild(keyEl);
  node._keyEl = keyEl;

  if(isBranch){
    const badge = document.createElement('span');
    badge.className = 'badge';
    const count = Array.isArray(value) ? value.length : Object.keys(value).length;
    badge.textContent = `${Array.isArray(value) ? 'Array' : 'Object'} · ${count}`;
    card.appendChild(badge);
  }else{
    const sep = document.createElement('span');
    sep.className = 'node-sep';
    sep.textContent = ':';
    card.appendChild(sep);

    const valueEl = document.createElement('span');
    valueEl.className = 'node-value ' + typeClass(value);
    valueEl.textContent = formatPrimitive(value);
    card.appendChild(valueEl);

    /* 该字段的内容本身就是 JSON：右上角给角标，点击即以 JSON 展开 */
    const jsonValue = parseJsonInString(value);
    if(jsonValue !== undefined){
      node._jsonValue = jsonValue;
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

  if(isBranch) attachChildren(node, card, toggle, value, path);

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
      showToast('已达到 5000 个显示节点，请收起部分节点后继续展开'); break;
    }
    const node = stack.pop();
    if(!node.classList.contains('branch')) continue;
    node._ensureChildren?.();
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
function expandOne(node){
  if(!node.classList.contains('branch')) return;
  node._ensureChildren?.();
  node.classList.add('open');
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
  const v = node._value;
  if(v !== null && typeof v === 'object'){
    return JSON.stringify(v, null, 2);
  }
  if(typeof v === 'string') return v;
  return String(v);
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

function openModal(node){
  const full = nodeContentText(node);

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
  const ok = await copyText(nodeContentText(ctxTarget));
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

/* 数组下标归一化：[3] → [0]，使模板与具体元素位置无关 */
function normalizePath(p){
  return p.replace(/\[\d+\]/g, '[0]');
}

/* prefix 按 JSONPath 段边界判断是否为 path 的严格前缀（避免 $.a 误配 $.ab） */
function isPathPrefix(prefix, path){
  const p = normalizePath(prefix);
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
    file: fileName.textContent || '',
    savedAt: Date.now()
  };
  saveTemplate();
  updateTemplateStatus();
  showToast(`模板已记录：${paths.length} 个展开节点`);
}

/* 展开节点：数组只走第一项，对象走全部子节点 */
function childNodesToVisit(node){
  const c = directChildrenContainer(node);
  if(!c) return [];
  const kids = [...c.children].filter(n => n.classList.contains('tree-node'));
  /* 字符串型 JSON 节点：按解析出来的值判断是否为数组 */
  const v = node._jsonValue !== undefined ? node._jsonValue : node._value;
  return Array.isArray(v) ? kids.slice(0, 1) : kids;
}

/* 按归一化路径集合展开（结构模板与刷新恢复共用）：
   数组只走第一项；返回最深的命中节点，由调用方决定是否居中 */
function expandByPaths(paths){
  const root = tree.firstElementChild;
  const set = new Set(paths || []);
  if(!root || !set.size) return null;

  const pathList = [...set];
  let deepest = null;
  let deepestLen = -1;

  (function walk(node){
    if(!node.classList.contains('branch')){
      /* 字符串型 JSON 字段：命中它下级的路径时先按 JSON 展开，
         否则记录在它内部的结构会整体落空 */
      if(node._jsonValue !== undefined &&
         pathList.some(p => isPathPrefix(node.dataset.path, p))){
        buildJsonChildren(node);
      }else{
        return;
      }
    }
    if(!set.has(normalizePath(node.dataset.path))) return;

    expandOne(node);

    const p = node.dataset.path;
    if(p.length > deepestLen){ deepestLen = p.length; deepest = node; }

    childNodesToVisit(node).forEach(walk);
  })(root);

  return deepest;
}

/* 应用模板：展开所有命中的层级，返回最深的展开节点用于定位 */
function applyTemplate(){
  if(!template || !template.paths.length) return null;
  return expandByPaths(template.paths);
}

/* 按固定层数展开（无模板时的默认策略），数组同样只展开第一项 */
function expandLevels(node, levels){
  (function walk(n, remain){
    if(!n.classList.contains('branch') || remain <= 0) return;
    expandOne(n);
    childNodesToVisit(n).forEach(k => walk(k, remain - 1));
  })(node, levels);
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
    if(!node._isArrayItem) return;
    const label = arrayIndexLabel(node._path[node._path.length - 1]);
    node._key = label;
    node.dataset.searchText =
      `${label} ${primitiveToSearchText(node._value)}`.toLowerCase();
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

optStrictJsonl.addEventListener('change', () => {
  settings.strictJsonl = optStrictJsonl.checked;
  saveSettings();

  /* 立即对当前文件重校验：不合规就当场切成错误态，干净则原地重渲染。
     展开状态保留在同一份文档上，所以关掉严格模式后还能恢复到原来的层级。 */
  const doc = activeDoc();
  if(doc && doc.kind === 'jsonl'){
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
  if(!settings.limitValueHeight) return;
  clearTimeout(overflowResizeTimer);
  overflowResizeTimer = setTimeout(() => refreshValueOverflow(tree, true), 200);
});

/* 按当前 settings 重建当前文档的根结构（不重新读盘）。
   仅当当前文档是 JSONL 时生效。 */
function rebuildJsonlRoot(){
  const doc = activeDoc();
  if(!doc || doc.kind !== 'jsonl') return;

  snapshotDoc();
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
      rebuildJsonlRoot();   /* 根结构设置可能变了，当前 JSONL 立即生效 */
      applyValueHeightSetting();   /* 高度限制可能变了，立即生效 */
      applyRailStyle();   /* 多文件栏样式可能变了，立即生效 */
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

applyTemplateBtn.addEventListener('click', () => {
  closeSettings();
  const deepest = applyTemplate();
  if(deepest){
    requestAnimationFrame(() => centerNode(deepest));
    showToast('模板已应用');
  }else{
    showToast('模板未命中任何节点（结构可能不一致）');
  }
});

clearTemplateBtn.addEventListener('click', () => {
  template = null;
  try{ localStorage.removeItem(TEMPLATE_KEY); }catch(_){}
  updateTemplateStatus();
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
  if(!parsedData){ showToast('请先打开文件'); return; }
  editorHidden = new Set((template && template.hidden) || []);
  renderEditorTree();
  editorView.reset();
  editorMask.classList.add('open');
}

function closeEditor(){
  editorMask.classList.remove('open');
}

function renderEditorTree(){
  editorTree.textContent = '';
  const root = createEditorNode('root', parsedData, [], true);
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
function createEditorNode(key, value, path, isRoot=false, isArrayItem=false){
  const isBranch = value !== null && typeof value === 'object';
  const normPath = normalizePath(encodePath(path));

  const node = document.createElement('div');
  node.className = 'tree-node ed-node'
    + (isBranch ? ' branch' : '')
    + (isRoot ? ' root-node' : '');
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
    const count = Array.isArray(value) ? value.length : Object.keys(value).length;
    badge.textContent = `${Array.isArray(value) ? 'Array' : 'Object'} · ${count}`;
    card.appendChild(badge);

    if(Array.isArray(value)){
      const hint = document.createElement('span');
      hint.className = 'ed-hint';
      hint.textContent = '仅第一项结构';
      card.appendChild(hint);
    }
  }else{
    const typeEl = document.createElement('span');
    typeEl.className = 'badge';
    typeEl.textContent = getTypeName(value);
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

    const ensureChildren = pagedChildren(node, children, value, (childKey, childValue, isArr) =>
      createEditorNode(isArr ? arrayIndexLabel(childKey) : String(childKey), childValue,
        path.concat(childKey), false, isArr), () => {}, true);

    const toggleNode = e => {
      e.stopPropagation();
      if(!node.classList.contains('open')) ensureChildren();
      node.classList.toggle('open');
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

editorSaveBtn.addEventListener('click', () => {
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
  const focusNode = applyOpenPolicy();
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
  if(!e.target.closest('.node-card')) closeMenu();
});
document.addEventListener('keydown', e => {
  const modifier = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if(modifier && key === 'o'){ e.preventDefault(); chooseFiles(); return; }
  if(modifier && key === 'f' && activeDoc()){ e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
  if(modifier && key === 'w' && activeDoc() && !e.target.closest('input,textarea,[contenteditable]')){
    e.preventDefault(); closeDoc(activeDocId); return;
  }
  if(e.key === 'F3' && matches.length){
    e.preventDefault(); focusMatch((currentMatchIndex + (e.shiftKey ? -1 : 1) + matches.length) % matches.length); return;
  }
  if(e.key === 'Escape'){
    clearTimeout(searchTimer);
    expansionGeneration++;
    searchGeneration++;
    if(searchCount.textContent === '搜索中…') searchCount.textContent = '已取消';
    if(activeLoad) activeLoad.abort();
    closeMenu();
    closeModal();
    closeSettings();
    closeEditor();
  }
});

/* ---------- 搜索 ---------- */
searchInput.addEventListener('input', () => {
  searchGeneration++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchTree(searchInput.value), 160);
});

async function searchTree(query){
  const generation = ++searchGeneration;
  tree.querySelectorAll('.match,.current-match').forEach(n => n.classList.remove('match','current-match'));
  matches = [];
  currentMatchIndex = -1;
  nextMatchBtn.disabled = true;
  const q = query.trim().toLowerCase();
  if(!q){ searchCount.textContent = ''; return; }
  searchCount.textContent = '搜索中…';
  const result = await searchData(parsedData, q, {
    rootLabel: currentRootLabel, indexBase: settings.indexBase, hidden: getHiddenSet(),
    cancelled: () => generation !== searchGeneration
  });
  if(!result || generation !== searchGeneration) return;
  matches = result.hits;
  searchTruncated = result.truncated;
  if(!matches.length){ searchCount.textContent = '0'; return; }
  nextMatchBtn.disabled = false;
  focusMatch(0);
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

function focusMatch(index){
  tree.querySelectorAll('.current-match').forEach(n => n.classList.remove('current-match'));
  if(!matches.length) return;
  currentMatchIndex = index;
  let node = tree.firstElementChild;
  const path = matches[index];
  for(const key of path){
    if(!node) break;
    node._ensureChildren?.(key);
    node.classList.add('open');
    node = [...(directChildrenContainer(node)?.children || [])]
      .find(child => child._path?.length === node._path.length + 1 && child._path.at(-1) === key);
  }
  if(node){
    node.classList.add('current-match');
    openAncestors(node);
    requestAnimationFrame(() => { if(node.isConnected) centerNode(node); });
  }
  searchCount.textContent = `${index + 1} / ${matches.length}${searchTruncated ? '+' : ''}`;
  searchCount.title = searchTruncated ? '仅列出前 1000 项匹配，请缩小搜索范围' : '';
  scheduleOverflowSweep();
}

nextMatchBtn.addEventListener('click', () => {
  if(!matches.length) return;
  currentMatchIndex = (currentMatchIndex + 1) % matches.length;
  focusMatch(currentMatchIndex);
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
  /* 虚拟化开启时，目标可能在屏外被 content-visibility 跳过，
     测量前临时全量渲染，保证坐标准确（同步测量后立刻恢复） */
  const wasVirt = tree.classList.contains('virtualized');
  if(wasVirt) tree.classList.add('no-cv');

  const vp = viewport.getBoundingClientRect();
  const nd = node.getBoundingClientRect();

  mainView.state.x += (vp.left + vp.width/2) - (nd.left + nd.width/2);
  mainView.state.y += (vp.top + vp.height/2) - (nd.top + nd.height/2);
  mainView.apply();

  if(wasVirt) tree.classList.remove('no-cv');
}

/* ---------- 辅助 ---------- */
function encodePath(path){
  let result = '$';
  for(const part of path){
    if(typeof part === 'number' || /^\d+$/.test(String(part))){
      result += `[${part}]`;
    }else if(/^[A-Za-z_$][\w$]*$/.test(String(part))){
      result += `.${part}`;
    }else{
      result += `[${JSON.stringify(String(part))}]`;
    }
  }
  return result;
}

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
document.getElementById('reopenHint').textContent = desktop
  ? '从原路径读取文件，关闭后清除恢复记录'
  : '在浏览器本地保存文件副本';
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
    else if(action === 'reset' && activeDocId) resetView();
    else if(action === 'settings') openSettings();
    else if(action === 'about') showToast('JSON Atlas 0.1.0 · Apache-2.0 · 本地 JSON / JSONL 阅读器');
  });
})().catch(error => showToast('启动失败：' + error));
