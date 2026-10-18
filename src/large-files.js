import { PAGE_SIZE, encodeDataPath, normalizeDataPath } from './data.js';
import { sharedPageCache } from './page-cache.js';

export const DEFAULT_LARGE_FILE_MIB = 64;
export function normalizeThreshold(value) {
  const number = Number(value);
  return [32, 64, 128, 256].includes(number) ? number : DEFAULT_LARGE_FILE_MIB;
}
export const needsIndex = (size, threshold) => size > normalizeThreshold(threshold) * 1024 * 1024;
let sourceSequence = 0;

/** Native I/O is injected so lifecycle and paging can be tested without Tauri. */
export class IndexedDataSource {
  #request; #id; #root; #closed = false; #configuration = 0; #version = 0;
  #cache; #owner = ++sourceSequence; #inflight = new Map(); #prefetching = false;
  #pageGroups = new WeakMap();
  indexed = true;
  wrap = true;
  constructor(request, id, info, wrap = true, { cache = sharedPageCache } = {}) {
    this.#request = request; this.#id = id; this.#root = info.root; this.wrap = wrap;
    this.info = info;
    this.#cache = cache;
  }
  #check(signal) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error('文档已关闭');
  }
  matches(value) { return !this.#closed && value === this; }
  getRoot() { this.#check(); return this.#root; }
  async #call(op, args, signal) {
    this.#check(signal);
    const result = await this.#request(op, this.#id, { ...args, wrap: args.wrap ?? this.wrap });
    this.#check(signal); return result;
  }
  async configure(wrap, strict) {
    const generation = ++this.#configuration;
    const result = await this.#call('info', { wrap, strict });
    if (generation !== this.#configuration) return;
    this.#version++; this.#cache.deleteOwner(this.#owner); this.#inflight.clear(); this.#pageGroups = new WeakMap();
    this.wrap = wrap; this.#root = result.root; this.info = result;
  }
  #group(path, limit, firstArrayOnly) { return JSON.stringify([this.wrap, path, limit, firstArrayOnly]); }
  #checkVersion(version, signal) {
    this.#check(signal);
    if (version !== this.#version) throw new DOMException('文档视图已改变', 'AbortError');
  }
  async getChildren(path, { offset = 0, key, limit = PAGE_SIZE, firstArrayOnly = false, signal, cache = true } = {}) {
    this.#check(signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
      throw new Error('无效的分页参数');
    }
    const version = this.#version, group = this.#group(path, limit, firstArrayOnly);
    const cached = cache && this.#cache.lookup(this.#owner, group, { offset: Math.floor(offset / limit) * limit, key });
    try {
      if (cached) {
        // Reusing data must not bypass the native file-change guard.
        await this.#call('check', {}, signal);
        this.#checkVersion(version, signal);
        if (cache !== 'prefetch') this.#cache.touch(cached.id);
        this.#pageGroups.set(cached.page, group);
        return cached.page;
      }
      const args = { path, offset, ...(key === undefined ? {} : { key }), limit, firstArrayOnly, wrap: this.wrap };
      const requestKey = JSON.stringify([version, args]);
      let pending = this.#inflight.get(requestKey);
      if (!pending) {
        pending = this.#call('page', args);
        this.#inflight.set(requestKey, pending);
        const clean = () => { if (this.#inflight.get(requestKey) === pending) this.#inflight.delete(requestKey); };
        pending.then(clean, clean);
      }
      const page = await pending;
      this.#checkVersion(version, signal);
      this.#pageGroups.set(page, group);
      if (cache) this.#cache.put(this.#owner, group, page, { speculative: cache === 'prefetch' });
      return page;
    } catch (error) {
      if (error.name !== 'AbortError' && version === this.#version) this.#cache.deleteOwner(this.#owner);
      throw error;
    }
  }
  retainPage(path, page, { firstArrayOnly = false } = {}) {
    const group = this.#pageGroups.get(page);
    if (this.#closed || group === undefined) return () => {};
    this.#cache.put(this.#owner, group, page);
    return this.#cache.retain(this.#owner, group, page.start);
  }
  async prefetchChildren(path, page, { firstArrayOnly = false, signal } = {}) {
    if (this.#closed || signal?.aborted || this.#prefetching || firstArrayOnly || page.end >= page.total) return;
    const { bytes, budget } = this.#cache.stats;
    if (budget - bytes < 256 * 1024) return;
    this.#prefetching = true;
    try { await this.getChildren(path, { offset: page.end, firstArrayOnly, signal, cache: 'prefetch' }); }
    catch { /* Speculative I/O must never replace a successfully mounted page. */ }
    finally { this.#prefetching = false; }
  }
  getText(path, { signal } = {}) { return this.#call('text', { path }, signal); }
  async search(query, { rootLabel = 'root', indexBase = 0, hidden = new Set(), cancelled = () => false, signal, limit = 1000 } = {}) {
    const hits = [], stack = [{ node: this.getRoot(), key: rootLabel }];
    const version = this.#version, batches = new Map();
    const finish = async truncated => {
      this.#checkVersion(version, signal);
      if (cancelled()) return null;
      if (this.info.searchBatch) {
        try { await this.#call('check', {}, signal); }
        catch (error) {
          if (error.name !== 'AbortError' && version === this.#version) this.#cache.deleteOwner(this.#owner);
          throw error;
        }
      }
      this.#checkVersion(version, signal);
      return cancelled() ? null : { hits, truncated };
    };
    const visible = node => !hidden.has(normalizeDataPath(encodeDataPath(node.path)));
    const small = node => (node.type === 'array' || node.type === 'object') && node.childCount > 0 && node.childCount <= 16;
    const pageFor = async frame => {
      this.#checkVersion(version, signal);
      const pathKey = JSON.stringify(frame.node.path), saved = batches.get(pathKey);
      if (saved) { batches.delete(pathKey); return saved; }
      const parent = stack.at(-2);
      if (this.info.searchBatch && frame.cursor === 0 && small(frame.node) && parent?.page) {
        const candidates = [frame.node];
        let items = frame.node.childCount;
        for (const node of parent.page.items.slice(parent.cursor - parent.page.start)) {
          if (candidates.length >= 8) break;
          if (!small(node) || !visible(node) || items + node.childCount > 64) continue;
          candidates.push(node); items += node.childCount;
        }
        if (candidates.length > 1) {
          try {
            const pages = await this.#call('searchPages', { paths: candidates.map(node => node.path) }, signal);
            this.#checkVersion(version, signal);
            if (cancelled()) return null;
            if (!Array.isArray(pages) || pages.length !== candidates.length) throw new Error('搜索批次无效');
            // Replace speculative results: nested trees cannot grow this cache.
            batches.clear();
            for (let i = 1; i < pages.length; i++) batches.set(JSON.stringify(candidates[i].path), pages[i]);
            return pages[0];
          } catch (error) {
            this.#checkVersion(version, signal);
            if (cancelled()) return null;
            // A future branch may be ambiguous or too large. Defer that error
            // until DFS actually reaches it, preserving result/limit semantics.
          }
        }
      }
      const page = await this.getChildren(frame.node.path, { offset: frame.cursor, signal, cache: false });
      this.#checkVersion(version, signal);
      return page;
    };
    while (stack.length) {
      this.#checkVersion(version, signal); if (cancelled()) return null;
      const frame = stack.at(-1), node = frame.node;
      if (!frame.visited) {
        frame.visited = true;
        if (hidden.has(normalizeDataPath(encodeDataPath(node.path)))) { stack.pop(); continue; }
        const branch = node.type === 'array' || node.type === 'object';
        const value = branch ? node.type : node.truncated ? await this.getText(node.path, { signal }) : String(node.value);
        if (cancelled()) return null;
        if (`${frame.key} ${value}`.toLowerCase().includes(query)) {
          hits.push(node.path); if (hits.length >= limit) return finish(true);
        }
        if (!branch) { stack.pop(); continue; }
        frame.cursor = 0; frame.page = null;
      }
      if (frame.cursor >= node.childCount) { stack.pop(); continue; }
      if (!frame.page || frame.cursor >= frame.page.end) {
        frame.page = await pageFor(frame);
        if (cancelled()) return null;
      }
      const child = frame.page.items[frame.cursor++ - frame.page.start];
      stack.push({ node: child, key: child.arrayItem ? String(child.key + indexBase) : child.key });
    }
    return finish(false);
  }
  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#version++; this.#cache.deleteOwner(this.#owner); this.#inflight.clear();
    this.#request('close', this.#id, {}).catch(console.error);
  }
}
