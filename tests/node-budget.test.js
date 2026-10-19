import test from 'node:test';
import assert from 'node:assert/strict';
import { NodeBudget } from '../src/node-budget.js';

function element(branch = false) {
  const node = {
    parentElement: null, children: [],
    classes: new Set(branch ? ['tree-node', 'open'] : ['tree-node']),
    classList: { contains: c => node.classes.has(c), remove: c => node.classes.delete(c) },
    append(...nodes) { for (const child of nodes) { child.parentElement = node; node.children.push(child); } },
    get firstElementChild() { return node.children[0]; },
    querySelectorAll() {
      const result = [], pending = [...node.children].reverse();
      while (pending.length) { const child = pending.pop(); if (child.classes.has('tree-node')) result.push(child); pending.push(...child.children.toReversed()); }
      return result;
    }
  };
  if (branch) {
    const container = element(); container.classes.clear(); node.append(container);
    node._discardChildren = () => { node.discarded = true; for (const child of container.children) child.parentElement = null; container.children = []; };
    node._trimChildren = selected => { container.children = container.children.filter(child => { if (!selected.has(child)) return true; child.parentElement = null; return false; }); };
  }
  return node;
}
function fixture() {
  const tree = element(); tree.classes.clear(); const root = element(true); tree.append(root);
  const old = element(true), recent = element(true);
  old.children[0].append(element(), element(), element());
  recent.children[0].append(element(), element(), element());
  root.children[0].append(old, recent);
  return { tree, root, old, recent, budget: new NodeBudget(tree, { limit: 9, target: 6 }) };
}
test('cleanup preserves read descendants and the root instead of collapsing everything', () => {
  const { budget, old, recent, root } = fixture();
  budget.touch(recent.children[0].children[0]);
  assert.equal(budget.notify(), true);
  assert.deepEqual(budget.reclaim(), { before: 9, after: 5, removed: 4 });
  assert.equal(old.parentElement, null); assert.notEqual(recent.parentElement, null); assert.equal(root.discarded, undefined);
  assert.equal(budget.warned, false);
});
test('a wide root stays open and keeps its identity after distant nodes are removed', () => {
  const { budget, tree, root } = fixture(); budget.target = 1;
  assert.equal(budget.reclaim().after, 1); assert.equal(root.discarded, undefined); assert(root.classes.has('open'));
  assert.equal(tree.querySelectorAll('.tree-node').length, 1);
  assert.deepEqual(budget.reclaim(), { before: 1, after: 1, removed: 0 });
});
test('nearby nodes and their ancestors survive while farther unread siblings are trimmed', () => {
  const { budget, old, recent, root } = fixture();
  for (const [branch, top] of [[old, 2000], [recent, 0]]) {
    for (const node of [branch, ...branch.querySelectorAll()]) {
      if (!node.firstElementChild) { const main = element(); main.classes.clear(); node.append(main); }
      node.firstElementChild.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 0, right: 100 });
    }
  }
  const result = budget.reclaim({ top: 0, bottom: 500, left: 0, right: 500 });
  assert.equal(result.after, 5); assert.equal(old.parentElement, null); assert.notEqual(recent.parentElement, null); assert(root.classes.has('open'));
});
test('cleanup does not discard a tree whose visible nodes have all been read', () => {
  const { budget, tree } = fixture();
  for (const node of tree.querySelectorAll()) budget.touch(node);
  assert.deepEqual(budget.reclaim(), { before: 9, after: 9, removed: 0 });
});
test('read tracking observes retained outer nodes and releases observers on discard/reset', () => {
  const original = globalThis.IntersectionObserver;
  let changed;
  const observed = new Set();
  globalThis.IntersectionObserver = class {
    constructor(callback) { changed = callback; }
    observe(node) { observed.add(node); }
    unobserve(node) { observed.delete(node); }
    disconnect() { observed.clear(); }
  };
  try {
    const { tree, old, recent } = fixture();
    const budget = new NodeBudget(tree, { limit: 9, target: 6, viewport: {} });
    budget.observe(tree.querySelectorAll());
    assert(observed.has(recent)); assert(!observed.has(recent.firstElementChild));
    changed([{ target: recent, isIntersecting: true }]);
    budget.reclaim(); assert.notEqual(recent.parentElement, null); assert.equal(old.parentElement, null);
    recent._disposeBudget(); assert(!observed.has(recent));
    budget.reset(); assert.equal(observed.size, 0);
  } finally {
    if (original) globalThis.IntersectionObserver = original; else delete globalThis.IntersectionObserver;
  }
});
test('notice only arms on warning and resets after reaching the limit or switching documents', () => {
  const { budget } = fixture();
  assert.equal(budget.update(), false); assert.equal(budget.notify(), true);
  assert.equal(budget.update(8), false); assert.equal(budget.update(9), false);
  budget.notify(); budget.reset(); assert.equal(budget.update(), false);
});
