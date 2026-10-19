// Release distant unread nodes, keeping the root, reading area and read paths.
export class NodeBudget {
  constructor(root, { limit = 5000, target = 4000, viewport } = {}) {
    this.root = root; this.limit = limit; this.target = target;
    this.warned = false;
    this.read = new WeakSet(); this.watched = new WeakSet();
    if (viewport && typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const node = entry.target;
          if (entry.isIntersecting && node && this.watched.has(node)) this.read.add(node);
        }
      }, { root: viewport, threshold: .01 });
    }
  }
  touch(node) { if (node) this.read.add(node); }
  observe(nodes) {
    if (!this.observer) return;
    for (const node of nodes) {
      if (this.watched.has(node) || !node.firstElementChild) continue;
      this.watched.add(node);
      // Observe the retained outer node, not content that viewport unloading
      // replaces; otherwise this observer would keep released card DOM alive.
      this.observer.observe(node);
      node._disposeBudget = () => { this.observer.unobserve(node); this.watched.delete(node); };
    }
  }
  count() { return this.root.querySelectorAll('.tree-node').length; }
  bounds(node) {
    // Reading a skipped child's header forces content-visibility to lay it out
    // and changes preceding estimates. Measure the outer box instead.
    const rect = node.getBoundingClientRect?.() || node.firstElementChild?.getBoundingClientRect?.();
    if (!rect) return null;
    return { top: rect.top, bottom: node.classList.contains('branch') ? Math.min(rect.bottom, rect.top + 80) : rect.bottom, left: rect.left, right: rect.right };
  }
  notify() { this.warned = true; return this.update(); }
  update(count = this.count()) {
    if (count < this.limit) this.warned = false;
    return this.warned;
  }
  reset() { this.observer?.disconnect(); this.warned = false; this.read = new WeakSet(); this.watched = new WeakSet(); }
  reclaim(viewport) {
    const nodes = [...this.root.querySelectorAll('.tree-node')];
    const before = nodes.length, protectedNodes = new Set(), parents = new Map(), distances = new Map();
    for (const node of nodes) {
      let parent = node.parentElement;
      while (parent && parent !== this.root && !parent.classList.contains('tree-node')) parent = parent.parentElement;
      parents.set(node, parent === this.root ? null : parent);
      const rect = this.bounds(node);
      const distance = rect && viewport ? Math.max(viewport.top - rect.bottom, rect.top - viewport.bottom, viewport.left - rect.right, rect.left - viewport.right, 0) : Infinity;
      distances.set(node, distance);
      if (this.read.has(node) || distance <= 400) protectedNodes.add(node);
    }
    for (const node of nodes.toReversed()) {
      if (protectedNodes.has(node) && parents.get(node)) protectedNodes.add(parents.get(node));
    }
    const rootNode = this.root.firstElementChild;
    const candidates = nodes.filter(node => node !== rootNode && !protectedNodes.has(node) && parents.get(node)?._trimChildren)
      .sort((a, b) => distances.get(b) - distances.get(a));
    const remaining = new Set(nodes), selected = new Set();
    for (const node of candidates) {
      if (remaining.size <= this.target) break;
      if (!remaining.has(node)) continue;
      for (const child of node.querySelectorAll('.tree-node')) { remaining.delete(child); selected.delete(child); }
      remaining.delete(node); selected.add(node);
    }
    const groups = new Map();
    for (const node of selected) {
      const parent = parents.get(node);
      if (!groups.has(parent)) groups.set(parent, new Set());
      groups.get(parent).add(node);
    }
    for (const [parent, children] of groups) parent._trimChildren(children);
    const after = this.count(); this.update(after);
    return { before, after, removed: before - after };
  }
}
