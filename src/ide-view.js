import { needsIndex } from './large-files.js';

export const normalizeViewMode = value => ['tree', 'auto', 'ide'].includes(value) ? value : 'tree';

export function parseIdeText(text, kind) {
  const parse = value => JSON.parse(value, (_key, item) => {
    if(typeof item === 'number' && !Number.isFinite(item)) throw new Error('数字超出可表示范围');
    return item;
  });
  if(kind !== 'jsonl') return {parsed:parse(text.replace(/^\uFEFF/, ''))};
  const records = [], lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    if(!line.trim()) return;
    try { records.push(parse(line)); } catch(error) { throw new Error(`第 ${i + 1} 行：${error.message}`); }
  });
  if(!records.length) throw new Error('JSONL 至少需要一条记录');
  return {records, bad:[], totalLines:lines.length};
}
export function formatIdeText(text, kind) {
  const result = parseIdeText(text, kind);
  return kind === 'jsonl' ? result.records.map(row => JSON.stringify(row)).join('\n') + '\n'
    : JSON.stringify(result.parsed, null, 2) + '\n';
}
export const ideTextLines = text => text.replace(/\r\n/g, '\n').split('\n',20001).map((text, i) => ({text, path:[i]}));

// Bound both traversal and output before creating any DOM. Even memory-backed
// documents may contain millions of fields or a single enormous string.
export function ideModel(doc, mode, threshold) {
  if(normalizeViewMode(mode) === 'tree' || doc.error || doc.source?.indexed || needsIndex(doc.size, threshold)) return null;
  const automatic = mode === 'auto';
  if((doc.text?.length || 0) > 2 * 1024 * 1024) return null;
  const lines = []; let nodes = 0, characters = 0;
  function emit(text, path) {
    characters += text.length;
    if(characters > 2 * 1024 * 1024 || lines.length >= 20000) throw new RangeError();
    lines.push({ text, path: [...path] });
  }
  function visit(value, path, depth, prefix = '', comma = '') {
    if(++nodes > (automatic ? 2000 : 10000) || depth > (automatic ? 12 : 64)) throw new RangeError();
    const indent = '  '.repeat(depth);
    if(value !== null && typeof value === 'object') {
      const array = Array.isArray(value), keys = Object.keys(value);
      if(keys.length > (automatic ? 2000 : 10000)) throw new RangeError();
      if(!keys.length) { emit(indent + prefix + (array ? '[]' : '{}') + comma, path); return; }
      emit(indent + prefix + (array ? '[' : '{'), path);
      keys.forEach((key, i) => visit(value[key], [...path, array ? Number(key) : key], depth + 1,
        array ? '' : JSON.stringify(key) + ': ', i < keys.length - 1 ? ',' : ''));
      emit(indent + (array ? ']' : '}') + comma, path);
    } else emit(indent + prefix + JSON.stringify(value) + comma, path);
  }
  try { visit(doc.data, [], 0); } catch(error) { if(error instanceof RangeError) return null; throw error; }
  return lines;
}

// Strings are consumed as a whole, including incomplete strings while typing,
// so braces inside values never change the nesting colours or guide columns.
export function ideDecorations(lines) {
  const stack = [];
  const result = [];
  lines.forEach(({text}, line) => {
    const whitespace = text.match(/^[\t ]*/)[0];
    let indent = 0;
    for(const c of whitespace) indent += c === '\t' ? 2 - indent % 2 : 1;
    const guides = [...new Map(stack.slice(-64).filter(frame => !text.trim() || frame.column < indent)
      .map(frame => [frame.column, {column:frame.column, colour:frame.colour}])).values()];
    const tokens = [];
    const pattern = /"(?:\\.|[^"\\])*(?:"|\\?$)|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]]/g;
    for(const match of text.matchAll(pattern)) {
      const value = match[0]; let className, partner;
      if(value[0] === '"') className = /^\s*:/.test(text.slice(match.index + value.length)) ? 'ide-key' : 'ide-string';
      else if(value === '{' || value === '[') {
        const colour = stack.length % 3;
        className = `ide-bracket-${colour}`;
        stack.push({kind:value, colour, column:indent, line, tokenIndex:tokens.length});
      } else if(value === '}' || value === ']') {
        const frame = stack.at(-1);
        if(frame?.kind === (value === '}' ? '{' : '[')) {
          className = `ide-bracket-${frame.colour}`; stack.pop();
          const opener = frame.line === line ? tokens[frame.tokenIndex] : result[frame.line].tokens[frame.tokenIndex];
          opener.partner = {line, column:match.index};
          partner = {line:frame.line, column:opener.start};
          if(line > frame.line + 1) result[frame.line].foldEnd = Math.max(result[frame.line].foldEnd ?? 0, line);
        }
        else className = 'ide-bracket-invalid';
      } else className = /^(true|false|null)$/.test(value) ? 'ide-literal' : 'ide-number';
      tokens.push({start:match.index, text:value, className, ...(partner ? {partner} : {})});
    }
    result.push({tokens,guides});
  });
  return result;
}

// Folding is a view projection only. Keep original offsets so edits can never
// accidentally replace the hidden part of a document.
export function ideProjection(text, folds = new Set()) {
  const lines = ideTextLines(text), decorations = ideDecorations(lines), visible = [], offsets = [];
  let raw = 0, hiddenUntil = -1, projected = 0;
  lines.forEach((line, i) => {
    if(i >= hiddenUntil) {
      offsets.push({visible:projected, raw, length:line.text.length});
      visible.push({...line, decoration:decorations[i], folded:folds.has(i) && decorations[i].foldEnd !== undefined});
      projected += line.text.length + 1;
      if(folds.has(i) && decorations[i].foldEnd !== undefined) hiddenUntil = decorations[i].foldEnd;
    }
    raw += line.text.length + 1;
  });
  return {lines:visible, text:visible.map(line => line.text).join('\n'), offsets};
}
export function ideRawOffset(projection, offset) {
  let row = projection.offsets[0];
  for(const candidate of projection.offsets) { if(candidate.visible > offset) break; row = candidate; }
  return row ? row.raw + Math.min(row.length, Math.max(0, offset - row.visible)) : 0;
}
export function ideProjectedEdit(raw, projection, edited) {
  let start = 0, end = projection.text.length, editedEnd = edited.length;
  while(start < end && start < editedEnd && projection.text[start] === edited[start]) start++;
  while(end > start && editedEnd > start && projection.text[end - 1] === edited[editedEnd - 1]) { end--; editedEnd--; }
  const from = ideRawOffset(projection, start), to = ideRawOffset(projection, end);
  if(raw.slice(from, to) !== projection.text.slice(start, end)) return null;
  return {text:raw.slice(0, from) + edited.slice(start, editedEnd) + raw.slice(to), caret:from + editedEnd - start};
}

export function renderIde(container, lines, document, onFold) {
  container.replaceChildren();
  const locations = new Map();
  const decorations = lines.every(line => line.decoration) ? lines.map(line => line.decoration) : ideDecorations(lines);
  for(const [i, line] of lines.entries()) {
    const row = document.createElement('div'); row.className = 'ide-line' + (line.folded ? ' folded' : '');
    const original = line.decoration ? line.path[0] : i;
    row.dataset.line = String(original + 1);
    const number = document.createElement('span'); number.className = 'ide-line-number'; number.textContent = String(original + 1);
    const decoration = line.decoration || decorations[i];
    if(onFold && decoration.foldEnd !== undefined) {
      const arrow = document.createElement('button'); arrow.className = 'ide-fold'; arrow.type = 'button';
      const label = line.folded ? '展开结构' : '折叠结构';
      arrow.setAttribute('aria-label', `${label}，第 ${original + 1} 行`);
      arrow.setAttribute('aria-expanded', String(!line.folded));
      arrow.addEventListener('click', () => onFold(original)); number.appendChild(arrow);
    }
    row.appendChild(number);
    const code = document.createElement('span'); code.className = 'ide-code';
    code.setAttribute('aria-hidden', 'true');
    for(const {column,colour} of decoration.guides) {
      const guide = document.createElement('span'); guide.className = `ide-guide ide-bracket-${colour}`;
      guide.dataset.column = String(column);
      guide.style.setProperty('--ide-column', String(column)); code.appendChild(guide);
    }
    // Text nodes only: JSON strings must never become HTML.
    let end = 0;
    for(const part of decoration.tokens) {
      code.appendChild(document.createTextNode(line.text.slice(end, part.start)));
      const token = document.createElement('span');
      token.className = part.className;
      token.dataset.column = String(part.start);
      token.textContent = part.text; code.appendChild(token); end = part.start + part.text.length;
    }
    code.appendChild(document.createTextNode(line.text.slice(end)));
    if(line.folded) { const hint = document.createElement('span'); hint.className = 'ide-fold-hint'; hint.textContent = ' …'; code.appendChild(hint); }
    row.appendChild(code); container.appendChild(row);
    const key = JSON.stringify(line.path); if(!locations.has(key)) locations.set(key, row);
  }
  return locations;
}
