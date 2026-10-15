import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium } from 'playwright-core';

const fixture = `<!doctype html><html><head>
<script src="https://github.githubassets.com/fixture.js"></script>
</head><body>
<div id="location"></div><div id="commit">Loading...</div><div id="xhr"></div><div id="upload"></div>
<button id="navigate">Directory</button><div id="links"></div>
<form action="/owner/repo/search"><input name="q" value="a+b"><button id="submit">Search</button></form>
<script>
  // A browser router must receive the upstream pathname before it initializes.
  const view = document.defaultView;
  function renderLocation() {
    document.querySelector('#location').textContent = view.location.pathname + view.location.search + view.location.hash;
  }
  if (!view.location.pathname.startsWith('/owner/repo')) throw new Error('No route matches the document path');
  renderLocation();
  view.addEventListener('popstate', renderLocation);
  document.cookie = 'local-session=must-not-reach-github';
  fetch('/owner/repo/latest-commit?branch=main').then(r => r.json()).then(data => {
    document.querySelector('#commit').textContent = data.message;
  });
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/owner/repo/tree-commit-info');
  xhr.onload = () => { document.querySelector('#xhr').textContent = JSON.parse(xhr.responseText).message; };
  xhr.send();
  fetch(new Request(new URL('/owner/repo/upload', location.origin), { method: 'POST', body: 'streamed body' }))
    .then(r => r.text()).then(text => { document.querySelector('#upload').textContent = text; });
  document.querySelector('#navigate').onclick = () => {
    view.history.pushState({ directory: true }, '', '/owner/repo/tree/main/sub?ref=a%2Fb#files');
    renderLocation();
  };
  const link = document.createElement('a');
  link.id = 'dynamic';
  link.href = '/owner/repo/tree/main/other#files';
  link.target = '_blank';
  link.textContent = 'New tab';
  document.querySelector('#links').append(link);
</script></body></html>`;

function browserExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find(path => existsSync(path));
}

test('browser pages keep their proxy prefix while routers and requests use GitHub paths', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable() });
  t.after(() => browser.close());

  for (const prefix of ['/gh/', '/', '/nested/proxy/']) {
    await t.test(`loads, navigates and submits under ${prefix}`, async t => {
      const upstreamRequests = [];
      const runtime = new Miniflare(convertV4MiniflareOptions({
        modules: true,
        scriptPath: fileURLToPath(new URL('../dist/_worker.js', import.meta.url)),
        compatibilityDate: process.env.WORKER_COMPATIBILITY_DATE || '2023-10-02',
        bindings: { PREFIX: prefix, GH_TOKEN: 'server-only-token' },
        cf: false,
        outboundService: { node: async (request, response) => {
          const url = new URL(request.url, 'https://github.com');
          upstreamRequests.push({ pathname: url.pathname, cookie: request.headers.cookie, authorization: request.headers.authorization });
          if (url.pathname === '/fixture.js') {
            response.writeHead(200, { 'content-type': 'application/javascript' });
            response.end('window.fixtureAssetLoaded = true;');
          } else if (/\/(latest-commit|tree-commit-info)$/.test(url.pathname)) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ message: 'Commit details loaded' }));
          } else if (url.pathname.endsWith('/upload')) {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            response.end(Buffer.concat(chunks));
          } else {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"original"' });
            response.end(fixture);
          }
        } },
      }));
      t.after(() => runtime.dispose());
      const base = await runtime.ready;
      const proxyBase = base.origin + prefix;
      const context = await browser.newContext();
      t.after(() => context.close());
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      const unexpectedRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      context.on('request', request => {
        if (!request.url().startsWith(proxyBase)) unexpectedRequests.push(request.url());
      });
      // Canonicalization also handles the abbreviated target format and preserves fragments.
      await page.goto(proxyBase + 'github.com/owner/repo#readme', { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('#commit').textContent === 'Commit details loaded' &&
        document.querySelector('#xhr').textContent === 'Commit details loaded' &&
        document.querySelector('#upload').textContent === 'streamed body');
      assert.equal(await page.locator('#location').textContent(), '/owner/repo#readme');
      assert.equal(page.url(), proxyBase + 'https://github.com/owner/repo#readme');
      assert.equal(await page.evaluate(() => window.fixtureAssetLoaded), true);
      assert.equal(await page.evaluate(() => document.defaultView.getComputedStyle(document.body).display), 'block');
      assert.ok(!(await page.content()).includes('server-only-token'));

      await page.click('#navigate');
      assert.equal(page.url(), proxyBase + 'https://github.com/owner/repo/tree/main/sub?ref=a%2Fb#files');
      assert.equal(await page.locator('#location').textContent(), '/owner/repo/tree/main/sub?ref=a%2Fb#files');
      await page.goBack();
      await page.waitForFunction(() => document.querySelector('#location').textContent === '/owner/repo#readme');
      await page.goForward();
      await page.waitForFunction(() => document.querySelector('#location').textContent.includes('/tree/main/sub'));
      await page.reload({ waitUntil: 'load' });
      assert.equal(await page.locator('#location').textContent(), '/owner/repo/tree/main/sub?ref=a%2Fb#files');

      const popupPromise = context.waitForEvent('page');
      await page.click('#dynamic', { button: 'middle' });
      const popup = await popupPromise;
      await popup.waitForLoadState('load');
      await popup.waitForFunction(() => document.querySelector('#upload').textContent === 'streamed body' &&
        document.querySelector('#commit').textContent === 'Commit details loaded' &&
        document.querySelector('#xhr').textContent === 'Commit details loaded');
      assert.equal(popup.url(), proxyBase + 'https://github.com/owner/repo/tree/main/other#files');
      await popup.close();

      await Promise.all([page.waitForURL('**/owner/repo/search?q=a%2Bb'), page.click('#submit')]);
      await page.waitForFunction(() => document.querySelector('#upload').textContent === 'streamed body' &&
        document.querySelector('#commit').textContent === 'Commit details loaded' &&
        document.querySelector('#xhr').textContent === 'Commit details loaded');
      assert.equal(page.url(), proxyBase + 'https://github.com/owner/repo/search?q=a%2Bb');
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpectedRequests, []);
      assert.ok(upstreamRequests.some(request => request.pathname.endsWith('/latest-commit')));
      assert.ok(upstreamRequests.some(request => request.pathname.endsWith('/tree-commit-info')));
      for (const request of upstreamRequests) {
        assert.equal(request.cookie, undefined);
        assert.equal(request.authorization, undefined);
        assert.ok(!request.pathname.startsWith(prefix + 'https://'));
      }
    });
  }
});
