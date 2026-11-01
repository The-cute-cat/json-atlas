import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function validateRelease(tag, versions) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    throw new Error('发布标签必须采用 vX.Y.Z 格式');
  }
  const expected = tag.slice(1);
  for (const source of ['npm', 'lock', 'lockRoot', 'tauri', 'cargo', 'cargoLock']) {
    const version = versions[source];
    if (version !== expected) throw new Error(`${source} 版本 ${version} 与标签 ${tag} 不一致`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const manifest = read('../src-tauri/Cargo.toml').split(/^\[/m)
    .find(section => section.startsWith('package]'));
  const cargo = manifest?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLock = read('../src-tauri/Cargo.lock').split('[[package]]')
    .find(section => /^name = "json-atlas"$/m.test(section))
    ?.match(/^version = "([^"]+)"/m)?.[1];
  const lock = JSON.parse(read('../package-lock.json'));
  validateRelease(process.env.RELEASE_TAG, {
    npm: JSON.parse(read('../package.json')).version,
    lock: lock.packages[''].version,
    lockRoot: lock.version,
    tauri: JSON.parse(read('../src-tauri/tauri.conf.json')).version,
    cargo, cargoLock
  });
  console.log(`发布版本检查通过：${process.env.RELEASE_TAG}`);
}
