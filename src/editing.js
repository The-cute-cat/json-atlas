// Copy only the edited ancestry; never mutate previous revisions or prototypes.
export function valueAt(root, path) {
  let value = root;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('节点已不存在');
    value = value[key];
  }
  return value;
}

export function replaceValue(root, path, replacement) {
  valueAt(root, path);
  if (!path.length) return replacement;
  const result = Array.isArray(root) ? root.slice() : { ...root };
  let target = result, original = root;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const next = i === path.length - 1 ? replacement :
      Array.isArray(original[key]) ? original[key].slice() : { ...original[key] };
    Object.defineProperty(target, key, { value: next, enumerable: true, writable: true, configurable: true });
    target = next; original = original[key];
  }
  return result;
}

export function parseEdit(text, type) {
  if (type === 'string') return text;
  const value = JSON.parse(text);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (actual !== type || (type === 'number' && !Number.isFinite(value))) throw new Error('内容与所选类型不一致');
  return value;
}

export function serializeDocument(doc) {
  return doc.kind === 'jsonl' ? doc.records.map(row => JSON.stringify(row)).join('\n') + '\n' : JSON.stringify(doc.parsed, null, 2) + '\n';
}
