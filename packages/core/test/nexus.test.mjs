/** Nexus Mods API client tests (no network — injected fake fetchImpl). */
import { parseNxmUrl, gameIdForNxm } from '../src/nexus/nxm.ts';
import { NexusClient } from '../src/nexus/client.ts';
import { NexusError, NEXUS_DOMAINS, domainToGameId } from '../src/nexus/types.ts';

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}`)); };

/** Build a fake fetch that records the last call and returns a canned response. */
function fakeFetch({ status = 200, json = {}, headers = {} } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const h = new Headers(headers);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: h,
      json: async () => json,
    };
  };
  impl.calls = calls;
  return impl;
}

console.log('Nexus domain map:');
check('NEXUS_DOMAINS XIII-2 -> finalfantasyxiii2', NEXUS_DOMAINS['XIII-2'] === 'finalfantasyxiii2');
check('domainToGameId reverse maps', domainToGameId['lightningreturnsfinalfantasy13'] === 'XIII-LR');

console.log('\nparseNxmUrl:');
{
  const r = parseNxmUrl('nxm://finalfantasyxiii2/mods/1/files/42?key=abc&expires=1700000000&user_id=7');
  check('domain', r.domain === 'finalfantasyxiii2');
  check('modId', r.modId === 1);
  check('fileId', r.fileId === 42);
  check('key', r.key === 'abc');
  check('expires (number)', r.expires === 1700000000);
  check('userId (number)', r.userId === 7);
}
{
  // Params optional.
  const r = parseNxmUrl('nxm://finalfantasy13/mods/9/files/3');
  check('optional params absent', r.key === undefined && r.expires === undefined && r.userId === undefined);
}
{
  let threw = false;
  try { parseNxmUrl('not a url at all'); } catch { threw = true; }
  check('malformed url throws', threw);
}
{
  let threw = false;
  try { parseNxmUrl('nxm://finalfantasyxiii2/mods/1/oops/42'); } catch { threw = true; }
  check('bad path shape throws', threw);
}
check('gameIdForNxm maps to XIII-2', gameIdForNxm('finalfantasyxiii2') === 'XIII-2');
check('gameIdForNxm unknown -> undefined', gameIdForNxm('skyrim') === undefined);

console.log('\nNexusClient.validate + rate limit:');
{
  const ff = fakeFetch({
    status: 200,
    json: {
      user_id: 7, key: 'KEY123', name: 'tester', email: 't@example.com',
      profile_url: 'https://x', is_premium: false, is_supporter: true,
    },
    headers: {
      'X-RL-Daily-Remaining': '2490',
      'X-RL-Hourly-Remaining': '95',
      'X-RL-Daily-Reset': '2026-06-12 00:00:00 +0000',
      'X-RL-Hourly-Reset': '2026-06-11 15:00:00 +0000',
    },
  });
  const client = new NexusClient({ apiKey: 'KEY123', appVersion: '9.9.9', fetchImpl: ff });
  const v = await client.validate();
  check('validate returns user_id', v.user_id === 7);
  check('validate path correct', ff.calls[0].url === 'https://api.nexusmods.com/v1/users/validate.json');
  check('apikey header set', ff.calls[0].init.headers.apikey === 'KEY123');
  check('Application-Name header', ff.calls[0].init.headers['Application-Name'] === 'open-nova');
  check('Application-Version header', ff.calls[0].init.headers['Application-Version'] === '9.9.9');
  check('User-Agent header', /^open-nova\/9\.9\.9 \(.+\)$/.test(ff.calls[0].init.headers['User-Agent']));
  check('lastRateLimit dailyRemaining', client.lastRateLimit.dailyRemaining === 2490);
  check('lastRateLimit hourlyRemaining', client.lastRateLimit.hourlyRemaining === 95);
  check('lastRateLimit dailyReset', client.lastRateLimit.dailyReset === '2026-06-12 00:00:00 +0000');
  check('lastRateLimit hourlyReset', client.lastRateLimit.hourlyReset === '2026-06-11 15:00:00 +0000');
}

console.log('\nNexusClient 401:');
{
  const ff = fakeFetch({ status: 401, json: { message: 'nope' } });
  const client = new NexusClient({ apiKey: 'bad', fetchImpl: ff });
  let err;
  try { await client.validate(); } catch (e) { err = e; }
  check('401 throws NexusError', err instanceof NexusError);
  check('401 status', err?.status === 401);
}

console.log('\nNexusClient 429:');
{
  const ff = fakeFetch({ status: 429, json: {} });
  const client = new NexusClient({ apiKey: 'k', fetchImpl: ff });
  let err;
  try { await client.getModInfo('finalfantasy13', 5); } catch (e) { err = e; }
  check('429 throws NexusError', err instanceof NexusError && err.status === 429);
}

console.log('\ngetModFiles + pickPrimaryFile:');
{
  const files = [
    { file_id: 1, name: 'Old', version: '1.0', category_id: 2, category_name: 'OLD_VERSION', is_primary: false, size: 10, size_kb: 10, file_name: 'old.zip', uploaded_timestamp: 100, mod_version: '1.0', description: '' },
    { file_id: 2, name: 'Main', version: '2.0', category_id: 1, category_name: 'MAIN', is_primary: true, size: 20, size_kb: 20, file_name: 'main.zip', uploaded_timestamp: 200, mod_version: '2.0', description: '' },
  ];
  const ff = fakeFetch({ status: 200, json: { files, file_updates: [] } });
  const client = new NexusClient({ apiKey: 'k', fetchImpl: ff });
  const r = await client.getModFiles('finalfantasy13', 5);
  check('getModFiles path', ff.calls[0].url === 'https://api.nexusmods.com/v1/games/finalfantasy13/mods/5/files.json');
  check('getModFiles returns files', r.files.length === 2);
  const primary = client.pickPrimaryFile(r.files);
  check('pickPrimaryFile prefers is_primary', primary?.file_id === 2);
}
{
  const client = new NexusClient({ apiKey: 'k', fetchImpl: fakeFetch() });
  // No is_primary -> falls back to MAIN category.
  const main = client.pickPrimaryFile([
    { file_id: 1, category_name: 'OPTIONAL', is_primary: false, uploaded_timestamp: 100 },
    { file_id: 2, category_name: 'MAIN', is_primary: false, uploaded_timestamp: 50 },
  ]);
  check('pickPrimaryFile falls back to MAIN', main?.file_id === 2);
  // No is_primary, no MAIN -> newest by timestamp.
  const newest = client.pickPrimaryFile([
    { file_id: 1, category_name: 'OPTIONAL', is_primary: false, uploaded_timestamp: 100 },
    { file_id: 2, category_name: 'OPTIONAL', is_primary: false, uploaded_timestamp: 300 },
  ]);
  check('pickPrimaryFile falls back to newest', newest?.file_id === 2);
  check('pickPrimaryFile empty -> undefined', client.pickPrimaryFile([]) === undefined);
}

console.log('\ngetDownloadLink:');
{
  // Non-Premium with no grant -> 403 from server -> NexusError(403) with nxm hint.
  const ff = fakeFetch({ status: 403, json: {} });
  const client = new NexusClient({ apiKey: 'k', fetchImpl: ff });
  let err;
  try { await client.getDownloadLink('finalfantasy13', 5, 42); } catch (e) { err = e; }
  check('403 without grant throws NexusError 403', err instanceof NexusError && err.status === 403);
  check('403 message advises nxm flow', /nxm/i.test(err?.message ?? ''));
  check('download_link path (no query)', ff.calls[0].url === 'https://api.nexusmods.com/v1/games/finalfantasy13/mods/5/files/42/download_link.json');
}
{
  // With key + expires grant -> returns the link array, with query params.
  const links = [{ name: 'Nexus CDN', short_name: 'Nexus', URI: 'https://cdn/file.zip' }];
  const ff = fakeFetch({ status: 200, json: links });
  const client = new NexusClient({ apiKey: 'k', fetchImpl: ff });
  const r = await client.getDownloadLink('finalfantasy13', 5, 42, { key: 'abc', expires: 1700000000 });
  check('grant returns link array', Array.isArray(r) && r[0].URI === 'https://cdn/file.zip');
  const u = new URL(ff.calls[0].url);
  check('grant query key', u.searchParams.get('key') === 'abc');
  check('grant query expires', u.searchParams.get('expires') === '1700000000');
  check('grant path correct', u.pathname === '/v1/games/finalfantasy13/mods/5/files/42/download_link.json');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
