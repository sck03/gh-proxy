import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import worker from '../index.js';

const origin = 'https://proxy.example';
const apiPath = '/https://api.github.com/repos/owner/repo';

// Existing protocol cases also verify that the configurable root prefix still works.
function fetchAtRoot(request, env = {}) {
  return worker.fetch(request, { PREFIX: '/', ...env });
}

function request(path, init = {}) {
  return new Request(origin + path, { ...init, ...(init.body ? { duplex: 'half' } : {}) });
}

function upstream(t, handler = () => new Response('ok')) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const call = { url: new URL(String(input)), ...init, headers: new Headers(init?.headers) };
    calls.push(call);
    return handler(call, calls.length);
  });
  return calls;
}

test('normalizes plain, encoded and abbreviated GitHub URLs without changing signed queries', async (t) => {
  const calls = upstream(t);
  for (const path of [
    '/https://github.com/owner/repo',
    '/github.com/owner/repo',
    '/https:/github.com/owner/repo',
    '/http://github.com/owner/repo',
    '/HTTPS%3a%2f%2fgithub.com%2fowner%2frepo',
  ]) {
    assert.equal((await fetchAtRoot(request(path), {})).status, 200);
    assert.equal(calls.at(-1).url.href, 'https://github.com/owner/repo');
  }
  const signed = 'https://release-assets.githubusercontent.com/assets/a%2Fb?sig=a%2Bb%2F%3D&name=a+b';
  await fetchAtRoot(request('/' + signed), {});
  assert.equal(calls.at(-1).url.href, signed);
  await fetchAtRoot(request('/' + encodeURIComponent(signed)), {});
  assert.equal(calls.at(-1).url.href, signed);
});

test('rejects unsupported hosts, schemes, credentials and ports without fetching', async (t) => {
  const calls = upstream(t);
  for (const target of [
    'https://github.com.evil.example/repo',
    'https://www.raw.githubusercontent.com/repo',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://github.com:8443/owner/repo',
    'https://user:secret@github.com/owner/repo',
    'ftp://github.com/owner/repo',
    'https%3A%2F%2Fgithub.com%2F%',
  ]) {
    const response = await fetchAtRoot(request('/' + target), {});
    assert.ok(response.status >= 400, target);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
  assert.equal(calls.length, 0);
});

test('whitespace in WHITE_LIST cannot disable the remaining rules', async (t) => {
  const calls = upstream(t);
  const env = { WHITE_LIST: ' /allowed/, ,\t, ' };
  assert.equal((await fetchAtRoot(request('/github.com/other/repo'), env)).status, 403);
  assert.equal((await fetchAtRoot(request('/github.com/other/repo?name=/allowed/'), env)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await fetchAtRoot(request('/github.com/allowed/repo'), env)).status, 200);
  assert.equal((await fetchAtRoot(request('/github.com/%61llowed/repo'), env)).status, 200);
});

test('normalizes PREFIX and resolves root-relative resources only from a valid local referer', async (t) => {
  const calls = upstream(t);
  const env = { PREFIX: ' //gh// ' };
  await fetchAtRoot(request('/gh/github.com/owner/repo'), env);
  assert.equal(calls.at(-1)?.url.href, 'https://github.com/owner/repo');
  for (const prefix of ['/', '/gh/']) {
    await fetchAtRoot(request('/assets/app.js?v=1', {
      headers: { referer: origin + prefix + 'https://github.com/owner/repo' },
    }), { PREFIX: prefix });
    assert.equal(calls.at(-1).url.href, 'https://github.com/assets/app.js?v=1');
  }
  const count = calls.length;
  for (const referer of ['https://other.example/gh/github.com/owner/repo', origin + '/gh/https://evil.example/']) {
    assert.equal((await fetchAtRoot(request('/assets/app.js', { headers: { referer } }), { PREFIX: '/gh/' })).status, 404);
  }
  assert.equal(calls.length, count);
});

test('rewrites blob and Gist file URLs without corrupting raw usernames or revisions', async (t) => {
  const calls = upstream(t);
  const cases = [
    ['/github.com/owner/repo/blob/main/dir/blob/file.txt?q=a%2Fb', 'https://raw.githubusercontent.com/owner/repo/main/dir/blob/file.txt?q=a%2Fb'],
    ['/gist.github.com/raw-user/abcdef/', 'https://gist.githubusercontent.com/raw-user/abcdef/raw/'],
    ['/gist.github.com/owner/abcdef/123abc', 'https://gist.githubusercontent.com/owner/abcdef/raw/123abc/'],
    ['/gist.github.com/owner/abcdef/raw/file.txt', 'https://gist.githubusercontent.com/owner/abcdef/raw/file.txt'],
    ['/gist.github.com/owner', 'https://gist.github.com/owner'],
  ];
  for (const [path, expected] of cases) {
    await fetchAtRoot(request(path), {});
    assert.equal(calls.at(-1).url.href, expected);
  }
});

test('injects GH_TOKEN only into read requests to api.github.com', async (t) => {
  const calls = upstream(t);
  const env = { GH_TOKEN: 'server-token' };
  await fetchAtRoot(request(apiPath), env);
  assert.match(calls.at(-1).headers.get('authorization'), /server-token$/);
  await fetchAtRoot(request(apiPath, { method: 'HEAD' }), env);
  assert.match(calls.at(-1).headers.get('authorization'), /server-token$/);
  await fetchAtRoot(request(apiPath + '?q=objects.githubusercontent.com'), env);
  assert.match(calls.at(-1).headers.get('authorization'), /server-token$/);
  for (const host of ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']) {
    await fetchAtRoot(request('/https://' + host + '/owner/repo'), env);
    assert.equal(calls.at(-1).headers.get('authorization'), null, host);
  }
  await fetchAtRoot(request(apiPath, { method: 'POST', body: '{}' }), env);
  assert.equal(calls.at(-1).headers.get('authorization'), null);
});

test('preserves caller credentials for GitHub and strips them from download hosts', async (t) => {
  const calls = upstream(t);
  const init = { headers: { authorization: 'Bearer caller-token' } };
  const env = { GH_TOKEN: 'server-token' };
  await fetchAtRoot(request(apiPath, init), env);
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer caller-token');
  for (const host of ['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']) {
    await fetchAtRoot(request('/https://' + host + '/download', init), env);
    assert.equal(calls.at(-1).headers.get('authorization'), null);
  }
});

test('removes private and hop-by-hop headers while preserving Git and download headers', async (t) => {
  const calls = upstream(t);
  const stripped = {
    host: 'proxy.example', referer: origin, origin, cookie: 'session=secret',
    'cf-connecting-ip': '192.0.2.1', 'cf-connecting-ipv6': '2001:db8::1',
    'true-client-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.1',
    'cf-access-client-secret': 'access-secret', 'cf-access-jwt-assertion': 'access-jwt',
    forwarded: 'for=192.0.2.1', 'proxy-authorization': 'Basic secret',
    connection: 'keep-alive, x-private', 'keep-alive': 'timeout=5', 'x-private': 'secret',
  };
  const preserved = {
    range: 'bytes=100-199', 'if-range': '"etag"', 'git-protocol': 'version=2',
    'accept-encoding': 'gzip, br', 'user-agent': 'git/2.49',
  };
  await fetchAtRoot(request(apiPath, { headers: { ...stripped, ...preserved } }), {});
  for (const name of Object.keys(stripped)) assert.equal(calls[0].headers.get(name), null, name);
  for (const [name, value] of Object.entries(preserved)) assert.equal(calls[0].headers.get(name), value, name);
});

test('preserves streaming, encoding and range metadata without buffering the body', async (t) => {
  let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.close(); } }, { highWaterMark: 0 });
  upstream(t, () => new Response(body, {
    status: 206,
    headers: {
      'content-type': 'application/octet-stream', 'content-encoding': 'gzip',
      'content-length': '100', 'content-range': 'bytes 100-199/1000', 'accept-ranges': 'bytes', etag: '"etag"',
      'set-cookie': 'github-session=secret', 'clear-site-data': '"*"',
      connection: 'keep-alive, x-private, access-control-allow-origin', 'keep-alive': 'timeout=5', 'x-private': 'secret',
    },
  }));
  const response = await fetchAtRoot(request(apiPath), {});
  assert.equal(response.body, body);
  assert.equal(pulls, 0);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  for (const [name, value] of Object.entries({
    'content-encoding': 'gzip', 'content-length': '100', 'content-range': 'bytes 100-199/1000', 'accept-ranges': 'bytes', etag: '"etag"',
  })) assert.equal(response.headers.get(name), value, name);
  for (const name of ['set-cookie', 'clear-site-data', 'connection', 'keep-alive', 'x-private']) {
    assert.equal(response.headers.get(name), null, name);
  }
  await response.body.cancel();
});

test('preserves HEAD size, 304 validators and existing text charsets', async (t) => {
  upstream(t, ({ method }) => new Response(null, { status: method === 'HEAD' ? 200 : 304, headers: {
    'content-length': '4096', etag: '"v1"', 'content-type': 'text/plain; Charset=iso-8859-1',
  } }));
  const head = await fetchAtRoot(request(apiPath, { method: 'HEAD' }), {});
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), '4096');
  assert.equal(head.headers.get('content-type'), 'text/plain; Charset=iso-8859-1');
  const response = await fetchAtRoot(request(apiPath, { headers: { 'if-none-match': '"v1"' } }), {});
  assert.equal(response.status, 304);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('etag'), '"v1"');
});

test('follows trusted download redirects, cancels unused bodies and drops cross-origin credentials', async (t) => {
  let cancelled = false;
  const asset = 'https://release-assets.githubusercontent.com/assets/file?X-Amz-Signature=a%2Fb';
  const calls = upstream(t, (_, count) => count === 1
    ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: asset } })
    : new Response('download'));
  const response = await fetchAtRoot(request(apiPath, { headers: { authorization: 'Bearer caller-token' } }), {
    WHITE_LIST: '/owner/', GH_TOKEN: 'server-token',
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'download');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.href, asset);
  assert.equal(calls[1].headers.get('authorization'), null);
  assert.equal(cancelled, true);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('resolves relative redirects and retains same-origin authentication', async (t) => {
  const calls = upstream(t, (_, count) => count === 1
    ? new Response(null, { status: 301, headers: { location: '../renamed?x=a%2Fb' } })
    : new Response('ok'));
  await fetchAtRoot(request(apiPath), { GH_TOKEN: 'server-token' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.href, 'https://api.github.com/repos/renamed?x=a%2Fb');
  assert.match(calls[1].headers.get('authorization'), /server-token$/);
});

test('rejects untrusted redirects and redirect loops without leaking URLs or tokens', async (t) => {
  let destination = 'https://evil.example/?secret=token';
  const calls = upstream(t, () => new Response(null, { status: 302, headers: { location: destination } }));
  for (const location of [destination, 'http://127.0.0.1/', 'https://user:secret@github.com/', 'https://github.com:8443/', 'ftp://github.com/']) {
    destination = location;
    const count = calls.length;
    const response = await fetchAtRoot(request(apiPath), { GH_TOKEN: 'server-token' });
    assert.equal(response.status, 502, location);
    assert.equal(calls.length, count + 1);
    assert.doesNotMatch(await response.text(), /secret|token/);
  }
  destination = 'https://api.github.com/loop';
  const count = calls.length;
  const response = await fetchAtRoot(request(apiPath), {});
  assert.equal(response.status, 502);
  assert.ok(calls.length - count <= 6);
});

test('returns body-preserving redirects to the client without replaying a Git POST', async (t) => {
  let uploaded;
  const calls = upstream(t, async ({ body }) => {
    uploaded = await new Response(body).text();
    return new Response(null, { status: 307, headers: { location: '/owner/renamed.git/git-upload-pack' } });
  });
  const response = await fetchAtRoot(request('/gh/https://github.com/owner/repo.git/git-upload-pack', {
    method: 'POST', body: new Blob(['git packet']).stream(), headers: { 'content-type': 'application/x-git-upload-pack-request' },
  }), { PREFIX: '/gh/' });
  assert.equal(uploaded, 'git packet');
  assert.equal(calls.length, 1);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), '/gh/https://github.com/owner/renamed.git/git-upload-pack');
});

test('does not treat a successful API Location header as a redirect', async (t) => {
  const location = 'https://api.github.com/repos/owner/repo/issues/1';
  const calls = upstream(t, () => new Response('{}', { status: 201, headers: { location } }));
  const response = await fetchAtRoot(request(apiPath, { method: 'POST', body: '{}' }), {});
  assert.equal(calls.length, 1);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('location'), location);
});

test('preflights explicitly allow Authorization and error responses include CORS', async (t) => {
  const calls = upstream(t);
  const preflight = await fetchAtRoot(request(apiPath, { method: 'OPTIONS', headers: {
    'access-control-request-headers': 'authorization, range, git-protocol',
  } }), {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, range, git-protocol');
  assert.doesNotMatch(preflight.headers.get('access-control-allow-methods'), /TRACE/);
  const denied = await fetchAtRoot(request(apiPath), { WHITE_LIST: '/someone-else/' });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), '*');
  assert.equal(calls.length, 0);
});

test('local HEAD routes have no body and ASSET_URL is limited to the homepage', async (t) => {
  const calls = upstream(t);
  for (const path of ['/', '/gh', '/gh/', '/gh/index.html', '/gh/robots.txt', '/gh/favicon.ico']) {
    const response = await fetchAtRoot(request(path, { method: 'HEAD' }), { PREFIX: 'gh' });
    assert.ok(response.status < 300, path);
    assert.equal(response.body, null, path);
  }
  assert.equal((await fetchAtRoot(request('/'), { ASSET_URL: 'javascript:alert(1)' })).status, 200);
  assert.equal((await fetchAtRoot(request('/'), { ASSET_URL: origin + '/loop' })).status, 200);
  const redirect = await fetchAtRoot(request('/'), { ASSET_URL: 'https://example.com/home' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/home');
  assert.equal((await fetchAtRoot(request('/evil.example/file'), { ASSET_URL: 'https://example.com/home' })).status, 400);
  assert.equal(calls.length, 0);
});

test('authenticated traffic is not shared-cacheable and fetch errors are sanitized', async (t) => {
  const calls = upstream(t, () => new Response('private', { headers: { 'cache-control': 'public, max-age=3600' } }));
  const response = await fetchAtRoot(request(apiPath), { GH_TOKEN: 'server-token' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(calls[0].cache, undefined);
  assert.deepEqual(calls[0].cf, { cacheTtlByStatus: { '100-599': -1 } });
  assert.equal(calls[0].headers.get('cache-control'), 'no-store');
  t.mock.method(globalThis, 'fetch', () => { throw new Error('request failed: https://api.github.com/?secret=token'); });
  const error = await fetchAtRoot(request(apiPath), {});
  assert.equal(error.status, 502);
  assert.equal(await error.text(), 'Upstream request failed');
  assert.equal(error.headers.get('access-control-allow-origin'), '*');
});

test('header timeout aborts fetch and does not limit a download after headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  upstream(t, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = fetchAtRoot(request(apiPath), { UPSTREAM_TIMEOUT_MS: '1000' });
  t.mock.timers.tick(1001);
  const response = await pending;
  assert.equal(response.status, 504);

  let fetchSignal;
  upstream(t, ({ signal }) => { fetchSignal = signal; return new Response('slow download'); });
  const download = await fetchAtRoot(request(apiPath), { UPSTREAM_TIMEOUT_MS: '1000' });
  t.mock.timers.tick(1001);
  assert.equal(fetchSignal.aborted, false);
  assert.equal(await download.text(), 'slow download');
});

test('propagates client cancellation before and after upstream headers', async (t) => {
  const controller = new AbortController();
  let fetchSignal;
  const calls = upstream(t, ({ signal }) => { fetchSignal = signal; return new Response('ok'); });
  await fetchAtRoot(request(apiPath, { signal: controller.signal }), {});
  controller.abort();
  assert.equal(fetchSignal.aborted, true);
  const aborted = await fetchAtRoot(request(apiPath, { signal: controller.signal }), {});
  assert.equal(aborted.status, 499);
  assert.equal(calls.length, 1);
});

test('reports a malformed Token configuration without exposing its value', async (t) => {
  const calls = upstream(t);
  const response = await fetchAtRoot(request(apiPath), { GH_TOKEN: 'secret\ninvalid' });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(await response.text(), 'Invalid GH_TOKEN configuration');
  assert.equal(calls.length, 0);
});

test('defaults to /gh/ without any environment variables or Token', async (t) => {
  const calls = upstream(t);
  const response = await worker.fetch(request('/gh/https://github.com/owner/repo'));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url.href, 'https://github.com/owner/repo');
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal((await worker.fetch(request('/gh'))).status, 200);
  assert.equal((await worker.fetch(request('/gh/'))).status, 200);
  assert.equal(calls.length, 1);
});

test('editing only DEFAULTS configures the copied Worker and optional variables can override it', async (t) => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const defaults = {
    PREFIX: '/manual/', ASSET_URL: 'https://homepage.example/', WHITE_LIST: '/allowed/',
    GH_TOKEN: 'code-token', UPSTREAM_TIMEOUT_MS: 1000,
  };
  const edited = source.replace(/const DEFAULTS = \{[\s\S]*?\n\};/, `const DEFAULTS = ${JSON.stringify(defaults)};`);
  const { default: copiedWorker } = await import('data:text/javascript;base64,' + Buffer.from(edited).toString('base64'));
  const calls = upstream(t);

  const home = await copiedWorker.fetch(request('/manual/'));
  assert.equal(home.headers.get('location'), defaults.ASSET_URL);
  assert.equal((await copiedWorker.fetch(request('/manual/github.com/blocked/repo'))).status, 403);
  assert.equal(calls.length, 0);
  const api = await copiedWorker.fetch(request('/manual/https://api.github.com/repos/allowed/repo'));
  assert.equal(api.status, 200);
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer code-token');

  const env = { PREFIX: '/custom/', ASSET_URL: '', WHITE_LIST: '', GH_TOKEN: 'env-token' };
  assert.equal((await copiedWorker.fetch(request('/custom/'), env)).status, 200);
  const overridden = await copiedWorker.fetch(request('/custom/https://api.github.com/repos/other/repo'), env);
  assert.equal(overridden.status, 200);
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer env-token');
  await copiedWorker.fetch(request('/custom/https://api.github.com/repos/other/repo'), { ...env, GH_TOKEN: '' });
  assert.equal(calls.at(-1).headers.get('authorization'), null);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  upstream(t, ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = copiedWorker.fetch(request('/manual/https://github.com/allowed/repo'));
  t.mock.timers.tick(1001);
  assert.equal((await pending).status, 504);
});
