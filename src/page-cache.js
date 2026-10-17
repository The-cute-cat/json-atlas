// This is a retained-data estimate, not a measurement of the JS engine heap.
export function estimatePageBytes(page) {
  let bytes = 0;
  const pending = [page];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') bytes += 24 + value.length * 2;
    else if (value && typeof value === 'object') {
      bytes += Array.isArray(value) ? 40 : 64;
      for (const key of Object.keys(value)) {
        bytes += 24 + key.length * 2;
        pending.push(value[key]);
      }
    } else bytes += 8;
  }
  return bytes;
}

export class PageCache {
  #entries = new Map(); #bytes = 0;
  constructor({ budget = 32 * 1024 * 1024, maxEntries = 512 } = {}) {
    if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new Error('无效的缓存预算');
    this.budget = budget; this.maxEntries = maxEntries;
  }
  get stats() {
    return { bytes: this.#bytes, entries: this.#entries.size, budget: this.budget,
      pinned: [...this.#entries.values()].filter(entry => entry.pins > 0).length };
  }
  #key(owner, group, start) { return JSON.stringify([owner, group, start]); }
  lookup(owner, group, { offset, key }) {
    for (const [id, entry] of this.#entries) {
      if (entry.owner !== owner || entry.group !== group) continue;
      if (key !== undefined ? entry.page.items.some(item => item.key === key) : entry.page.start === offset) {
        return { id, page: entry.page };
      }
    }
    return null;
  }
  touch(id) {
    const entry = this.#entries.get(id);
    if (entry) { this.#entries.delete(id); this.#entries.set(id, entry); }
  }
  put(owner, group, page, { speculative = false } = {}) {
    const id = this.#key(owner, group, page.start);
    if (this.#entries.has(id)) { if (!speculative) this.touch(id); return id; }
    const bytes = estimatePageBytes(page) + id.length * 2 + group.length * 2 + 128;
    if (bytes > this.budget || !this.maxEntries) return null;
    if (speculative && (this.#bytes + bytes > this.budget || this.#entries.size >= this.maxEntries)) return null;
    // Admission must not empty useful history if pinned entries leave no room.
    const unpinned = [...this.#entries].filter(([, entry]) => !entry.pins);
    const removableBytes = unpinned.reduce((sum, [, entry]) => sum + entry.bytes, 0);
    if (this.#bytes - removableBytes + bytes > this.budget || this.#entries.size - unpinned.length >= this.maxEntries) return null;
    for (const [oldId, entry] of unpinned) {
      if (this.#bytes + bytes <= this.budget && this.#entries.size < this.maxEntries) break;
      this.#entries.delete(oldId); this.#bytes -= entry.bytes;
    }
    this.#entries.set(id, { owner, group, page, bytes, pins: 0 }); this.#bytes += bytes;
    return id;
  }
  retain(owner, group, start) {
    const entry = this.#entries.get(this.#key(owner, group, start));
    if (!entry) return () => {};
    entry.pins++;
    let released = false;
    return () => { if (!released) { released = true; entry.pins--; } };
  }
  deleteOwner(owner) {
    for (const [id, entry] of this.#entries) {
      if (entry.owner === owner) { this.#entries.delete(id); this.#bytes -= entry.bytes; }
    }
  }
}

// All open documents share this budget; opening more tabs cannot multiply it.
export const sharedPageCache = new PageCache();
