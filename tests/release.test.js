import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/check-release.js';

const versions = { npm: '0.1.0', lock: '0.1.0', lockRoot: '0.1.0', tauri: '0.1.0', cargo: '0.1.0', cargoLock: '0.1.0' };

test('release distinguishes stable and prerelease tags', () => {
  assert.deepEqual(validateRelease('v0.1.0', versions), { prerelease: false });
  for (const suffix of ['alpha.0', 'beta.1', 'rc.2']) {
    const version = `0.1.0-${suffix}`;
    const prereleaseVersions = Object.fromEntries(Object.keys(versions).map(source => [source, version]));
    assert.deepEqual(validateRelease(`v${version}`, prereleaseVersions), { prerelease: true });
    for (const source of Object.keys(versions)) {
      assert.throws(() => validateRelease(`v${version}`, { ...prereleaseVersions, [source]: '0.1.0' }), /不一致/);
    }
  }
});

test('release rejects branch names and invalid tags', () => {
  for (const tag of [undefined, 'main', '0.1.0', 'v0.1', 'v0.1.0/other', 'v0.1.0-rc', 'v0.1.0-beta.01', 'v0.1.0-dev.1', 'v0.1.0\n']) {
    assert.throws(() => validateRelease(tag, versions), /vX.Y.Z/);
  }
});

test('release rejects a mismatch in each manifest', () => {
  for (const source of Object.keys(versions)) {
    assert.throws(() => validateRelease('v0.1.0', { ...versions, [source]: '0.2.0' }), /不一致/);
    assert.throws(() => validateRelease('v0.1.0', { ...versions, [source]: undefined }), /不一致/);
  }
});
