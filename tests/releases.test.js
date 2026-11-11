import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLatestRelease, newerRelease } from '../src/releases.js';

test('release notifications compare version components and skip draft and preview tags', () => {
  assert.equal(newerRelease({ tag_name: 'v0.10.0' }, '0.9.8'), '0.10.0');
  assert.equal(newerRelease({ tag_name: 'v0.9.8' }, '0.10.0'), null);
  assert.equal(newerRelease({ tag_name: 'v0.10.0' }, '0.10.0+local'), null);
  assert.equal(newerRelease({ tag_name: 'v0.10.0' }, '0.10.0-rc.1'), '0.10.0');
  assert.equal(newerRelease({ tag_name: 'v0.11.0', draft: true }, '0.10.0'), null);
  assert.equal(newerRelease({ tag_name: 'v0.11.0', prerelease: true }, '0.10.0'), null);
  assert.equal(newerRelease({ tag_name: 'v0.11.0-beta.1' }, '0.10.0'), null);
});

test('a repository without a stable release is distinct from a failed check', async () => {
  assert.equal(await checkLatestRelease('0.3.0', async () => new Response(null, { status: 404 })), null);
  await assert.rejects(checkLatestRelease('0.3.0', async () => new Response(null, { status: 403 })), /HTTP 403/);
  const latest = await checkLatestRelease('0.3.0', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/The-cute-cat/json-atlas/releases/latest');
    assert.equal(options.credentials, 'omit');
    return Response.json({ tag_name: 'v0.4.0' });
  });
  assert.equal(latest, '0.4.0');
});
