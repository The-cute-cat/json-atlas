import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function validateRelease(tag, versions) {
  const match = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.exec(tag ?? '');
  if (!match || match[0] !== tag) {
    throw new Error('发布标签必须采用 vX.Y.Z、vX.Y.Z-alpha.N、vX.Y.Z-beta.N 或 vX.Y.Z-rc.N 格式');
  }
  const expected = tag.slice(1);
  for (const source of ['npm', 'lock', 'lockRoot', 'tauri', 'cargo', 'cargoLock']) {
    const version = versions[source];
    if (version !== expected) throw new Error(`${source} 版本 ${version} 与标签 ${tag} 不一致`);
  }
  return { prerelease: Boolean(match[1]) };
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
  const { prerelease } = validateRelease(process.env.RELEASE_TAG, {
    npm: JSON.parse(read('../package.json')).version,
    lock: lock.packages[''].version,
    lockRoot: lock.version,
    tauri: JSON.parse(read('../src-tauri/tauri.conf.json')).version,
    cargo, cargoLock
  });
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `prerelease=${prerelease}\n`);
  }
  console.log(`发布版本检查通过：${process.env.RELEASE_TAG}`);
}
