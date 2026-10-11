// Pure data operations shared by the reader, worker and regression tests.
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const PAGE_SIZE = 100;

export function parseJsonl(text) {
  const records = [], bad = [];
  let start = 0, totalLines = 0;
  // Avoid split(): it retains an additional array of every line in a large file.
  for (let end = 0; end <= text.length; end++) {
    if (end !== text.length && text.charCodeAt(end) !== 10) continue;
    const raw = text.slice(start, end).replace(/^\uFEFF/, '').trim();
    start = end + 1;
    totalLines++;
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('//')) {
      bad.push({ line: totalLines, text: raw.slice(0, 160), comment: true,
        message: 'JSONL 规范不支持注释行（严格模式）' });
      continue;
    }
    try { records.push(JSON.parse(raw)); }
    catch (error) { bad.push({ line: totalLines, text: raw.slice(0, 160), message: error.message }); }
  }
  return { records, bad, totalLines };
}

export function parseDocument(text, name) {
  text = text.replace(/^\uFEFF/, '');
  const head = text.trimStart().slice(0, 4096);
  let kind = /\.(jsonl|ndjson|jsonlines)$/i.test(name) ? 'jsonl' : 'json';
  if (!/\.json$/i.test(name) && (/^\{[^\n]*\}\s*(\n|$)/.test(head) || /^\[[^\n]*\]\s*(\n|$)/.test(head))) kind = 'jsonl';
  if (kind === 'json') {
    try { return { kind, parsed: JSON.parse(text) }; }
    catch (error) {
      const result = parseJsonl(text);
      if (!result.records.length) return { kind, error: 'JSON 解析失败：\n' + error.message };
      return { kind: 'jsonl', ...result };
    }
  }
  const result = parseJsonl(text);
  return { kind, ...result, error: result.records.length ? null : 'JSONL 内没有可解析的记录' };
}

export function* walkData(value, rootLabel = 'root', indexBase = 0, hidden = new Set()) {
  // Frames carry a cursor rather than pushing every array item onto a stack.
  const stack = [{ value, path: [], key: rootLabel, visited: false }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame.visited) {
      frame.visited = true;
      const norm = encodeDataPath(frame.path).replace(/\[\d+\]/g, '[0]');
      if (hidden.has(norm)) { stack.pop(); continue; }
      const v = frame.value;
      const type = v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);
      yield { path: frame.path, text: (frame.key + ' ' + type).toLowerCase() };
      if (v === null || typeof v !== 'object') { stack.pop(); continue; }
      frame.keys = Array.isArray(v) ? null : Object.keys(v);
      frame.length = frame.keys ? frame.keys.length : v.length;
      frame.cursor = 0;
    }
    if (frame.cursor >= frame.length) { stack.pop(); continue; }
    const key = frame.keys ? frame.keys[frame.cursor++] : frame.cursor++;
    stack.push({ value: frame.value[key], path: frame.path.concat(key),
      key: typeof key === 'number' ? String(key + indexBase) : key, visited: false });
  }
}

export function encodeDataPath(path) {
  return '$' + path.map(key => typeof key === 'number' || /^\d+$/.test(String(key))
    ? `[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`).join('');
}

export async function searchData(value, query, { rootLabel, indexBase, hidden, cancelled = () => false,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)), limit = 1000 } = {}) {
  const hits = [];
  let count = 0;
  for (const item of walkData(value, rootLabel, indexBase, hidden)) {
    if (cancelled()) return null;
    if (item.text.includes(query)) {
      hits.push(item.path);
      if (hits.length === limit) return { hits, truncated: true };
    }
    if (++count % 2000 === 0) await yieldTask();
  }
  return cancelled() ? null : { hits, truncated: false };
}
