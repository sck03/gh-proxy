import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../index.js';

function request(target, init = {}, env = {}) {
  return worker.fetch(new Request('https://proxy.example/gh/' + target, {
    ...init, ...(init.body ? { duplex: 'half' } : {}),
  }), env);
}

function upstream(t, handler = () => new Response('ok', { headers: { 'cache-control': 'public, max-age=600' } })) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const call = { ...init, url: new URL(String(input)), headers: new Headers(init.headers) };
    calls.push(call);
    return handler(call, calls.length);
  });
  return calls;
}

test('supports GitLab subgroups, raw files, archives and encoded API paths', async t => {
  const calls = upstream(t);
  const cases = [
    ['gitlab.com/team/sub/project/-/blob/main/README.md?inline=false', 'https://gitlab.com/team/sub/project/-/raw/main/README.md?inline=false'],
    ['https://gitlab.com/team/sub/project/-/blob/feature/fix/docs/-/blob/file.txt', 'https://gitlab.com/team/sub/project/-/raw/feature/fix/docs/-/blob/file.txt'],
    ['https://gitlab.com/team/sub/project/-/raw/main/docs/-/blob/file.txt', 'https://gitlab.com/team/sub/project/-/raw/main/docs/-/blob/file.txt'],
    ['https://gitlab.com/team/project/-/archive/main/project-main.tar.gz', 'https://gitlab.com/team/project/-/archive/main/project-main.tar.gz'],
    ['https://gitlab.com/api/v4/projects/team%2Fsub%2Fproject/repository/files/a%2Fb/raw?ref=feature%2Ffix', 'https://gitlab.com/api/v4/projects/team%2Fsub%2Fproject/repository/files/a%2Fb/raw?ref=feature%2Ffix'],
  ];
  for (const [input, expected] of cases) {
    assert.equal((await request(input, {}, { GH_TOKEN: 'github-only-token' })).status, 200);
    assert.equal(calls.at(-1).url.href, expected);
    assert.equal(calls.at(-1).headers.get('authorization'), null);
  }
  await request(encodeURIComponent(cases[4][0]));
  assert.equal(calls.at(-1).url.href, cases[4][1]);
});

test('resolves git.io chains before checking the repository whitelist or converting blob URLs', async t => {
  const calls = upstream(t, (_call, count) => count === 1
    ? new Response(null, { status: 301, headers: { location: '/NextCode' } })
    : count === 2 ? new Response(null, { status: 302, headers: { location: 'https://github.com/owner/repo/blob/main/file.txt?sig=a%2Bb' } })
      : new Response('resolved file'));
  const response = await request('https://git.io/ShortCode', {
    headers: { authorization: 'Bearer caller-token', 'private-token': 'gitlab-token', range: 'bytes=0-63' },
  }, { WHITE_LIST: 'github.com', GH_TOKEN: 'github-only-token' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'resolved file');
  assert.deepEqual(calls.map(call => call.url.href), [
    'https://git.io/ShortCode', 'https://git.io/NextCode', 'https://raw.githubusercontent.com/owner/repo/main/file.txt?sig=a%2Bb',
  ]);
  for (const call of calls) {
    assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.headers.get('private-token'), null);
    assert.equal(call.headers.get('range'), 'bytes=0-63');
  }
});

test('git.io cannot bypass a repository whitelist or the allowed destination hosts', async t => {
  let destination;
  const calls = upstream(t, call => call.url.hostname === 'git.io'
    ? new Response(null, { status: 302, headers: { location: destination } }) : new Response('allowed file'));
  for (const [location, expectedStatus, expectedCalls] of [
    ['https://gitlab.com/allowed/repo/-/blob/main/file.txt', 200, 2],
    ['https://gitlab.com/other/repo/-/raw/main/file.txt?marker=/allowed/repo/', 403, 1],
    ['https://github.com/other/repo', 403, 1],
    ['https://example.invalid/allowed/repo/', 502, 1],
  ]) {
    destination = location;
    const before = calls.length;
    const response = await request('https://git.io/ShortCode', {}, { WHITE_LIST: '/allowed/repo/' });
    assert.equal(response.status, expectedStatus, location);
    assert.equal(calls.length - before, expectedCalls);
  }
});

test('supports GitLab token headers without injecting GH_TOKEN or sharing authenticated responses', async t => {
  const calls = upstream(t);
  for (const name of ['authorization', 'private-token', 'job-token', 'deploy-token']) {
    const response = await request('https://gitlab.com/api/v4/projects/1', {
      headers: { [name]: 'test-only-credential' },
    }, { GH_TOKEN: 'github-only-token' });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).headers.get(name), 'test-only-credential');
    if (name !== 'authorization') assert.equal(calls.at(-1).headers.get('authorization'), null);
    assert.equal(calls.at(-1).headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls.at(-1).cf.cacheTtlByStatus, { '100-599': -1 });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('keeps GitLab query-token responses private, including targets reached through git.io', async t => {
  const calls = upstream(t, call => call.url.hostname === 'git.io'
    ? new Response(null, { status: 302, headers: { location: 'https://gitlab.com/api/v4/projects/1?private_token=test-only-token' } })
    : new Response('data', { headers: { 'cache-control': 'public, max-age=3600' } }));
  for (const name of ['private_token', 'access_token', 'job_token', 'deploy_token']) {
    const response = await request('https://gitlab.com/api/v4/projects/1?' + name + '=test-only-token');
    assert.equal(calls.at(-1).headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const response = await request('https://git.io/ShortCode');
  assert.equal(calls.at(-1).url.hostname, 'gitlab.com');
  assert.equal(calls.at(-1).headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.at(-1).cf.cacheTtlByStatus, { '100-599': -1 });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('never forwards GitLab-specific headers to other services', async t => {
  const calls = upstream(t);
  const headers = { 'private-token': 'private-secret', 'job-token': 'job-secret', 'deploy-token': 'deploy-secret' };
  for (const host of ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'git.io', 'release-assets.githubusercontent.com']) {
    await request('https://' + host + '/owner/repo', { headers });
    for (const name of Object.keys(headers)) assert.equal(calls.at(-1).headers.get(name), null, host + ': ' + name);
    assert.equal(calls.at(-1).cf, undefined);
  }
});

test('preserves GitLab credentials on same-origin redirects and removes them on cross-origin redirects', async t => {
  let destination;
  const calls = upstream(t, call => call.url.pathname === '/group/project/-/raw/main/old.txt'
    ? new Response(null, { status: 302, headers: { location: destination } }) : new Response('data'));
  const headers = { authorization: 'Bearer caller', 'private-token': 'private-secret', 'job-token': 'job-secret', 'deploy-token': 'deploy-secret' };
  for (const [location, retain] of [['new.txt', true], ['https://github.com/owner/repo', false], ['https://release-assets.githubusercontent.com/file', false]]) {
    destination = location;
    const response = await request('https://gitlab.com/group/project/-/raw/main/old.txt', { headers });
    assert.equal(response.status, 200);
    for (const [name, value] of Object.entries(headers)) assert.equal(calls.at(-1).headers.get(name), retain ? value : null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
});

test('keeps GitLab Git upload redirects usable without replaying streams or leaking credentials', async t => {
  let destination;
  const calls = upstream(t, () => new Response(null, { status: 307, headers: { location: destination } }));
  for (const [location, expectedStatus] of [
    ['/group/renamed.git/git-upload-pack', 307],
    ['https://github.com/owner/repo.git/git-upload-pack', 502],
  ]) {
    destination = location;
    const before = calls.length;
    const response = await request('https://gitlab.com/group/project.git/git-upload-pack', {
      method: 'POST', body: 'git-packet', headers: { authorization: 'Basic test-only', 'private-token': 'test-only-token' },
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(calls.length - before, 1);
    if (expectedStatus === 307) assert.equal(response.headers.get('location'), '/gh/https://gitlab.com/group/renamed.git/git-upload-pack');
    else assert.equal(response.headers.get('location'), null);
  }
});

test('rejects lookalike, self-hosted, credentialed and nonstandard-port site URLs', async t => {
  const calls = upstream(t);
  for (const url of ['https://git.io.evil.example/a', 'https://gitlab.com.evil.example/a', 'https://gitlab.example.com/group/repo',
    'https://gitlab.com:8443/group/repo', 'https://user:secret@gitlab.com/group/repo']) {
    const response = await request(url);
    assert.equal(response.status, 400, url);
  }
  assert.equal(calls.length, 0);
});
