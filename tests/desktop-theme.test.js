import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the native bridge ordering without creating a real desktop window.
const source = readFileSync(new URL('../src/desktop.js', import.meta.url), 'utf8');
const bridge = source.slice(source.indexOf('let themeUpdate'), source.indexOf('let menuUpdate'))
  .replace('export function', 'function');

test('native auto menu repaint observes the new process palette, including rapid switches', async () => {
  let processDark = false;
  const paints = [], calls = [];
  const api = runInNewContext(bridge + '\n({updateWindowTheme, settled: () => themeUpdate})', {
    desktop: true, console,
    invoke: async (command, args) => {
      assert.equal(command, 'sync_menu_theme');
      await new Promise(resolve => setImmediate(resolve));
      processDark = args.dark;
      calls.push('palette');
    },
    getCurrentWebviewWindow: () => ({setTheme: async preference => {
      calls.push('window');
      paints.push({preference, dark:preference === null ? processDark : preference === 'dark'});
    }})
  });
  api.updateWindowTheme('dark', 'dark');
  api.updateWindowTheme('system', 'light');
  api.updateWindowTheme('system', 'dark');
  api.updateWindowTheme('light', 'light');
  await api.settled();
  assert.deepEqual(calls, ['palette','window','palette','window','palette','window','palette','window']);
  assert.deepEqual(paints, [
    {preference:'dark',dark:true}, {preference:null,dark:false},
    {preference:null,dark:true}, {preference:'light',dark:false}
  ]);
});
