import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, watchTheme } from '../src/theme.js';

test('theme defaults to system and follows live changes only while system is selected', () => {
  const root = {dataset:{},style:{}}, listeners = [];
  const media = {matches:true,addEventListener:(event, handler) => { assert.equal(event,'change'); listeners.push(handler); }};
  const apply = watchTheme(root,media);
  assert.equal(root.dataset.theme,'dark');
  media.matches=false; listeners[0](); assert.equal(root.dataset.theme,'light');
  apply('dark'); listeners[0](); assert.equal(root.dataset.theme,'dark');
  apply('light'); media.matches=true; listeners[0](); assert.equal(root.dataset.theme,'light');
  apply('system'); assert.equal(root.dataset.theme,'dark');
  assert.equal(root.style.colorScheme,'dark');
  assert.equal(normalizeTheme('invalid'),'system');
  assert.equal(watchTheme(root,undefined)('system'),'light');
});
