// Pure data operations shared by the reader, worker and regression tests.
import { compileSearch } from './search-pattern.js';
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
  let kind = /\.(jsonl|ndjson|jsonlines)$/i.test(name) ? 'jsonl' : 'json';
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

export function* walkData(value, rootLabel = 'root', indexBase = 0, hidden = new Set(), initialPath = [], lowercase = true) {
  // Frames carry a cursor rather than pushing every array item onto a stack.
  const stack = [{ value, path: initialPath, key: rootLabel, visited: false }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame.visited) {
      frame.visited = true;
      const norm = normalizeDataPath(encodeDataPath(frame.path));
      if (hidden.has(norm)) { stack.pop(); continue; }
      const v = frame.value;
      const type = v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);
      const rawText = frame.key + ' ' + type;
      yield { path: frame.path, text: lowercase ? rawText.toLowerCase() : rawText };
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
  return '$' + path.map(key => typeof key === 'number'
    ? `[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`).join('');
}

// Quoted object keys must remain literal, including digits and brackets in a key.
export function normalizeDataPath(path) {
  return path.replace(/\["(?:\\.|[^"\\])*"\]|\[\d+\]/g,
    segment => segment.startsWith('["') ? segment : '[0]');
}

export async function searchData(value, query, { rootLabel, indexBase, hidden, scopePath, caseSensitive = false, wholeWord = false, regex = false, cancelled = () => false,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)), limit = 1000 } = {}) {
  const hits = [];
  const matcher = compileSearch(query, { caseSensitive, wholeWord, regex });
  if (scopePath?.length) {
    for (const key of scopePath) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { hits: [], truncated: false };
      value = value[key];
    }
    const key = scopePath.at(-1); rootLabel = typeof key === 'number' ? String(key + (indexBase || 0)) : key;
    for (let i = 0; i <= scopePath.length; i++) if (hidden?.has(normalizeDataPath(encodeDataPath(scopePath.slice(0, i))))) return { hits: [], truncated: false };
  }
  let count = 0;
  for (const item of walkData(value, rootLabel, indexBase, hidden, scopePath || [], false)) {
    if (cancelled()) return null;
    if (matcher.test(item.text)) {
      hits.push(item.path);
      if (hits.length === limit) return { hits, truncated: true };
    }
    if (++count % 2000 === 0) await yieldTask();
  }
  return cancelled() ? null : { hits, truncated: false };
}
