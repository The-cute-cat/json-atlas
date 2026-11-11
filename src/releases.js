const stableVersion = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const endpoint = 'https://api.github.com/repos/The-cute-cat/json-atlas/releases/latest';

export function newerRelease(release, installed) {
  if (release?.draft || release?.prerelease || typeof release?.tag_name !== 'string') return null;
  const latest = stableVersion.exec(release.tag_name);
  const current = stableVersion.exec(installed.split(/[+-]/, 1)[0]);
  if (!latest || !current) return null;
  for (let index = 1; index <= 3; index++) {
    const next = BigInt(latest[index]);
    const previous = BigInt(current[index]);
    if (next !== previous) return next > previous ? latest[0].replace(/^v/, '') : null;
  }
  return installed.split('+', 1)[0].includes('-') ? latest[0].replace(/^v/, '') : null;
}

export async function checkLatestRelease(installed, request = fetch) {
  const response = await request(endpoint, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/vnd.github+json' }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return newerRelease(await response.json(), installed);
}
