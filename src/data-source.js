import { PAGE_SIZE, searchData } from './data.js';

/** Opening supplies root metadata; pages, text and search can require I/O.
 * Branch descriptors never contain a recursive value. This first adapter still
 * owns the fully parsed document; disk-backed loading is a subsequent stage. */
export class MemoryDataSource {
  paged = false;
  #value;
  #closed = false;
  #keys = new WeakMap();
  constructor(value) { this.#value = value; }
  matches(value) { return !this.#closed && Object.is(this.#value, value); }
  #check(signal) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error('文档已关闭');
  }
  #at(path) {
    this.#check();
    let value = this.#value;
    for (const key of path) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('节点不存在');
      value = value[key];
    }
    return value;
  }
  #objectKeys(value) {
    if (!this.#keys.has(value)) this.#keys.set(value, Object.keys(value));
    return this.#keys.get(value);
  }
  #describe(value, path) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const branch = type === 'array' || type === 'object';
    return { path: [...path], type,
      childCount: branch ? (type === 'array' ? value.length : this.#objectKeys(value).length) : 0,
      ...(branch ? {} : { value }) };
  }
  getRoot() { this.#check(); return this.#describe(this.#value, []); }
  async getChildren(path, { offset = 0, key, limit = PAGE_SIZE, firstArrayOnly = false, signal, all = false } = {}) {
    this.#check(signal);
    if(all) limit = 5000;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > (all ? 5000 : PAGE_SIZE)) throw new Error('无效的分页参数');
    const value = this.#at(path);
    const array = Array.isArray(value);
    const keys = value !== null && typeof value === 'object' && !array ? this.#objectKeys(value) : [];
    const total = array ? (firstArrayOnly ? Math.min(1, value.length) : value.length) : keys.length;
    let index = offset;
    if (key !== undefined) {
      index = array ? key : keys.indexOf(String(key));
      if (!Number.isSafeInteger(index) || index < 0 || index >= total) throw new Error('节点不存在');
    }
    const start = Math.floor(Math.max(0, Math.min(index, Math.max(0, total - 1))) / limit) * limit;
    const end = Math.min(start + limit, total);
    const items = [];
    for (let i = start; i < end; i++) {
      const childKey = array ? i : keys[i];
      items.push({ key: childKey, arrayItem: array, ...this.#describe(value[childKey], path.concat(childKey)) });
    }
    this.#check(signal);
    return { start, end, total, items, ...(all && total > limit ? { limited: true } : {}) };
  }
  async getText(path, { signal } = {}) {
    this.#check(signal);
    const value = this.#at(path);
    return value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  async search(query, options = {}) {
    this.#check(options.signal);
    const cancelled = options.cancelled || (() => false);
    return searchData(this.#value, query, { ...options,
      cancelled: () => this.#closed || options.signal?.aborted || cancelled() });
  }
  dispose() { this.#closed = true; this.#value = undefined; this.#keys = new WeakMap(); }
}
