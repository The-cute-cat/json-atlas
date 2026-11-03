import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'json-atlas-inline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const assets = join(root, 'assets');
  mkdirSync(assets);
  writeFileSync(join(root, 'index.html'), '<!DOCTYPE html><link rel="stylesheet" href="./assets/index-test.css"><script type="module" src="./assets/index-test.js"></script>');
  writeFileSync(join(assets, 'index-test.css'), 'body{color:green}');
  const workerSource = 'self.onmessage=()=>self.postMessage("你好 </script>");';
  for (const name of ['parser', 'search']) writeFileSync(join(assets, `${name}.worker-test.js`), workerSource);
  writeFileSync(join(assets, 'index-test.js'), ['parser', 'search'].map(name =>
    `new Worker(new URL(""+new URL("${name}.worker-test.js",import.meta.url).href,import.meta.url),{type:"module"});`).join('\n'));
  const output = join(root, 'output.html');
  const run = () => spawnSync(process.execPath, [resolve('scripts/build-single-file.js'), root, output], { encoding: 'utf8' });
  return { root, assets, output, run, workerSource };
}

test('offline bundle embeds both workers as Unicode-safe data URLs without external resources', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(f.output, 'utf8');
  assert.doesNotMatch(html, /import\.meta\.url|(?:src|href)="\.\/assets\//);
  const urls = [...html.matchAll(/data:text\/javascript;base64,([\w+/=]+)/g)];
  assert.equal(urls.length, 2);
  for (const [, encoded] of urls) assert.equal(Buffer.from(encoded, 'base64').toString(), f.workerSource);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'worker text must not close the entry script');
});

test('offline build fails when a worker is missing or Vite changes its reference format', t => {
  const f = fixture(t);
  rmSync(join(f.assets, 'search.worker-test.js'));
  assert.notEqual(f.run().status, 0);
  writeFileSync(join(f.assets, 'search.worker-test.js'), 'self.onmessage=()=>{};');
  writeFileSync(join(f.assets, 'index-test.js'), 'new Worker("./assets/search.worker-test.js");');
  assert.notEqual(f.run().status, 0);
});
