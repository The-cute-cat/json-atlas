import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewportWindow } from '../src/viewport-window.js';

function fixture() {
  let observer, time = 0;
  const timers = new Set();
  class Observer {
    nodes = new Set();
    constructor(callback, options) { this.callback = callback; this.options = options; observer = this; }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
  }
  const window = new ViewportWindow({}, { Observer, now: () => time,
    schedule: fn => { timers.add(fn); return fn; }, cancel: fn => timers.delete(fn) });
  return { window, timers, observer: () => observer,
    advance: milliseconds => { time += milliseconds; window.sweep(); },
    emit: (node, near) => observer.callback([{ target: node, isIntersecting: near }]) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('far fields unload after a grace interval and restore when they approach the viewport', async () => {
  const f = fixture(), node = { isConnected: true };
  let payload = 'loaded', sleeps = 0, restores = 0;
  f.window.watch(node, { suspend: () => { payload = null; sleeps++; }, resume: () => { payload = 'loaded'; restores++; } });
  assert.equal(f.observer().options.rootMargin, '800px');
  f.emit(node, false); f.advance(699); assert.equal(sleeps, 0);
  f.advance(1); assert.equal(payload, null); assert.equal(sleeps, 1);
  f.emit(node, true); await settle(); assert.equal(payload, 'loaded'); assert.equal(restores, 1);
  f.window.clear(); assert.equal(f.observer().nodes.size, 0); assert.equal(f.timers.size, 0);
});

test('search wake protects a distant field long enough to center the canvas', async () => {
  const f = fixture(), node = { isConnected: true };
  let sleeps = 0;
  f.window.watch(node, { suspend: () => { sleeps++; }, resume: () => true });
  f.emit(node, false); f.advance(700); assert.equal(sleeps, 1);
  await node._wakeViewport(); f.advance(700); assert.equal(sleeps, 1);
  f.advance(801); assert.equal(sleeps, 2); f.window.clear();
});

test('discarding a field cancels its restore and late results cannot resurrect it', async () => {
  const f = fixture(), node = { isConnected: true };
  let complete, restored = false, signal;
  f.window.watch(node, { suspend() {}, resume: async s => {
    signal = s; await new Promise(resolve => { complete = resolve; });
    if (!s.aborted) restored = true;
  } });
  f.emit(node, false); f.advance(700); f.emit(node, true); await settle();
  node._disposeViewport(); assert.equal(signal.aborted, true);
  complete(); await settle(); assert.equal(restored, false); assert.equal(f.observer().nodes.size, 0);
  f.window.clear();
});

test('rapid direction changes retry an aborted restore when the field becomes near again', async () => {
  const f = fixture(), node = { isConnected: true }, pending = [];
  f.window.watch(node, { suspend() {}, resume: signal => new Promise(resolve => pending.push({ signal, resolve })) });
  f.emit(node, false); f.advance(700); f.emit(node, true); await settle();
  f.emit(node, false); f.emit(node, true); assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(false); await settle(); assert.equal(pending.length, 2);
  pending[1].resolve(true); await settle(); f.window.clear();
});

test('failed restores can be retried explicitly and unsupported observers leave the tree alone', async () => {
  const f = fixture(), node = { isConnected: true }; let attempts = 0;
  f.window.watch(node, { suspend() {}, resume: () => ++attempts > 1 });
  f.emit(node, false); f.advance(700); f.emit(node, true); await settle(); assert.equal(attempts, 1);
  await node._wakeViewport(); assert.equal(attempts, 2); f.window.clear();
  const unsupported = new ViewportWindow({}, { Observer: null });
  unsupported.watch(node, { suspend: () => assert.fail('should remain mounted') });
  assert.equal(unsupported.enabled, false); unsupported.sweep();
});

test('timer callbacks are invoked without binding browser APIs to the controller', () => {
  let emit;
  class Observer { constructor(callback) { emit = callback; } observe() {} unobserve() {} }
  const node = {isConnected:true};
  const window = new ViewportWindow({}, {Observer,
    schedule: function(fn) { assert.equal(this, undefined); return fn; },
    cancel: function() { assert.equal(this, undefined); }
  });
  window.watch(node, {suspend(){},resume(){}});
  emit([{target:node,isIntersecting:false}]);window.clear();
});
