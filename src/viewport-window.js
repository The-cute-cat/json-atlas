/** Observe the transformed canvas in screen coordinates. Retain lightweight
 * shells while the caller releases payload DOM; no tree state lives here. */
export class ViewportWindow {
  #observer; #records = new Map(); #timer = null;
  constructor(root, { Observer = globalThis.IntersectionObserver, delay = 700,
    now = () => performance.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) } = {}) {
    this.delay = delay; this.now = now; this.schedule = (fn, ms) => schedule(fn, ms); this.cancel = id => cancel(id);
    if (Observer) this.#observer = new Observer(entries => {
      for (const entry of entries) {
        const record = this.#records.get(entry.target);
        if (!record) continue;
        record.near = entry.isIntersecting;
        if (record.near) this.wake(entry.target);
        else { record.farSince = this.now(); record.controller?.abort(); this.#queue(); }
      }
    }, { root, rootMargin: '800px' });
  }
  get enabled() { return !!this.#observer; }
  watch(node, operations) {
    if (!this.#observer || this.#records.has(node)) return;
    const record = { ...operations, near: true, sleeping: false, farSince: 0, protectedUntil: 0, loading: null, controller: null };
    this.#records.set(node, record);
    node._disposeViewport = () => this.unwatch(node);
    node._wakeViewport = () => this.wake(node, true);
    this.#observer.observe(node);
  }
  unwatch(node) {
    const record = this.#records.get(node);
    record?.controller?.abort(); this.#observer?.unobserve(node); this.#records.delete(node);
    delete node._disposeViewport; delete node._wakeViewport;
  }
  clear() {
    for (const node of this.#records.keys()) this.unwatch(node);
    if (this.#timer !== null) this.cancel(this.#timer);
    this.#timer = null;
  }
  #queue() {
    if (this.#timer !== null) return;
    this.#timer = this.schedule(() => { this.#timer = null; this.sweep(); }, this.delay);
  }
  sweep() {
    for (const [node, record] of this.#records) {
      if (node.isConnected === false) { this.unwatch(node); continue; }
      if (record.near || record.sleeping || record.loading) continue;
      if (this.now() < Math.max(record.farSince + this.delay, record.protectedUntil)) { this.#queue(); continue; }
      if (record.suspend() !== false) record.sleeping = true;
    }
  }
  wake(node, force = false) {
    const record = this.#records.get(node);
    if (!record) return Promise.resolve(true);
    if (force) record.protectedUntil = this.now() + 1500;
    if (record.loading) return record.loading;
    if (!record.sleeping) return Promise.resolve(true);
    const controller = new AbortController(); record.controller = controller;
    record.loading = Promise.resolve().then(() => {
      if (controller.signal.aborted) return false;
      return record.resume(controller.signal);
    }).then(restored => {
      if (!controller.signal.aborted && this.#records.get(node) === record && restored !== false) record.sleeping = false;
      return restored;
    }).catch(() => false).finally(() => {
      record.loading = null; record.controller = null;
      if (this.#records.get(node) !== record) return;
      if (record.near && record.sleeping && controller.signal.aborted) this.wake(node);
      else if (!record.near && !record.sleeping) this.#queue();
    });
    return record.loading;
  }
  async restoreAll() {
    // Limit concurrent native reads during an explicit layout/size change.
    const nodes = [...this.#records.keys()]; let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < nodes.length) await this.wake(nodes[cursor++], true);
    }));
  }
}
