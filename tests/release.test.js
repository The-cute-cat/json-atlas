import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease } from '../scripts/check-release.js';

const versions = { npm: '0.1.0', lock: '0.1.0', tauri: '0.1.0', cargo: '0.1.0' };

test('release accepts matching versions and rejects branch names or invalid tags', () => {
  assert.doesNotThrow(() => validateRelease('v0.1.0', versions));
  for (const tag of [undefined, 'main', '0.1.0', 'v0.1', 'v0.1.0/other', 'v0.1.0-rc.1']) {
    assert.throws(() => validateRelease(tag, versions), /vX.Y.Z/);
  }
});

test('release rejects a mismatch in each manifest', () => {
  for (const source of Object.keys(versions)) {
    assert.throws(() => validateRelease('v0.1.0', { ...versions, [source]: '0.2.0' }), /不一致/);
  }
});
