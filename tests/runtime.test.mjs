import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

function wireRequest(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, base), { method, headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Local test request timed out')));
    outgoing.end(body);
  });
}

test('Cloudflare runtime transfers bytes correctly', { timeout: 60_000 }, async (t) => {
  let serve = (_request, response) => response.end('ok');
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: fileURLToPath(new URL('../dist/_worker.js', import.meta.url)),
    compatibilityDate: process.env.WORKER_COMPATIBILITY_DATE || '2023-10-02',
    cf: false,
    bindings: { PREFIX: '/', GH_TOKEN: 'test-only-token', UPSTREAM_TIMEOUT_MS: '1000' },
    outboundService: { node: (request, response) => serve(request, response) },
  }));
  t.after(() => runtime.dispose());
  const base = await runtime.ready;
  const path = '/https://raw.githubusercontent.com/owner/repo/main/file.txt';
  const plaintext = Buffer.from('中文文件与 Git 下载内容\n'.repeat(500));

  for (const [encoding, compress, decompress] of [
    ['gzip', gzipSync, gunzipSync], ['br', brotliCompressSync, brotliDecompressSync],
  ]) {
    await t.test(`passes ${encoding} through without decompression and recompression`, async () => {
      const encoded = compress(plaintext);
      serve = (_request, response) => {
        response.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8', 'content-encoding': encoding,
          'content-length': encoded.length, etag: '"compressed"', 'set-cookie': 'session=private',
        });
        response.end(encoded);
      };
      const result = await wireRequest(base, path, { headers: { 'accept-encoding': encoding } });
      assert.equal(result.status, 200);
      assert.equal(result.headers['content-encoding'], encoding);
      assert.deepEqual(result.body, encoded);
      assert.deepEqual(decompress(result.body), plaintext);
      assert.equal(result.headers['set-cookie'], undefined);
    });
  }

  await t.test('preserves HEAD, partial content and conditional requests', async () => {
    serve = (request, response) => {
      const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', etag: '"version-1"' };
      if (request.headers['if-none-match'] === headers.etag) {
        response.writeHead(304, headers);
        response.end();
      } else if (request.headers.range) {
        assert.equal(request.headers.range, 'bytes=10-99');
        assert.equal(request.headers['if-range'], headers.etag);
        const partial = plaintext.subarray(10, 100);
        response.writeHead(206, { ...headers, 'content-length': partial.length, 'content-range': `bytes 10-99/${plaintext.length}` });
        response.end(partial);
      } else {
        response.writeHead(200, { ...headers, 'content-length': plaintext.length });
        response.end(request.method === 'HEAD' ? undefined : plaintext);
      }
    };
    const head = await wireRequest(base, path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(plaintext.length));
    assert.equal(head.body.length, 0);
    const partial = await wireRequest(base, path, { headers: { range: 'bytes=10-99', 'if-range': '"version-1"' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], `bytes 10-99/${plaintext.length}`);
    assert.equal(partial.headers['content-length'], '90');
    assert.deepEqual(partial.body, plaintext.subarray(10, 100));
    const conditional = await wireRequest(base, path, { headers: { 'if-none-match': '"version-1"' } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.etag, '"version-1"');
    assert.equal(conditional.body.length, 0);
  });

  await t.test('streams compressed Git uploads and binary responses', async () => {
    const upload = gzipSync(plaintext);
    let received;
    serve = async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = Buffer.concat(chunks);
      assert.equal(request.headers['git-protocol'], 'version=2');
      assert.equal(request.headers['content-encoding'], 'gzip');
      response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': plaintext.length });
      response.end(plaintext);
    };
    const result = await wireRequest(base, '/https://github.com/owner/repo.git/git-upload-pack', {
      method: 'POST', body: upload,
      headers: { 'content-type': 'application/x-git-upload-pack-request', 'content-encoding': 'gzip', 'git-protocol': 'version=2' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(received, upload);
    assert.deepEqual(result.body, plaintext);
  });

  await t.test('follows API asset redirects without forwarding its Token', async () => {
    const authorizations = [];
    serve = (request, response) => {
      authorizations.push(request.headers.authorization);
      if (authorizations.length === 1) {
        response.writeHead(302, { location: 'https://release-assets.githubusercontent.com/asset?sig=a%2Fb%2B' });
        response.end('redirect');
      } else {
        assert.match(request.url, /sig=a%2Fb%2B$/);
        response.writeHead(200, { 'content-length': plaintext.length, 'cache-control': 'public, max-age=3600' });
        response.end(plaintext);
      }
    };
    const result = await wireRequest(base, '/https://api.github.com/repos/owner/repo/releases/assets/1');
    assert.equal(result.status, 200);
    assert.deepEqual(authorizations, ['Bearer test-only-token', undefined]);
    assert.equal(result.headers['cache-control'], 'private, no-store');
    assert.deepEqual(result.body, plaintext);
  });

  await t.test('keeps downloading after the response-header deadline', async () => {
    serve = async (_request, response) => {
      response.writeHead(200, { 'content-length': plaintext.length });
      response.write(plaintext.subarray(0, 1));
      await new Promise(resolve => setTimeout(resolve, 1200));
      response.end(plaintext.subarray(1));
    };
    const result = await wireRequest(base, path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, plaintext);
  });

  await t.test('the copied JavaScript serves /gh/ without environment variables', async (t) => {
    const manual = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(new URL('../index.js', import.meta.url)),
      compatibilityDate: process.env.WORKER_COMPATIBILITY_DATE || '2023-10-02',
      cf: false,
      outboundService: { node: (request, response) => {
        assert.equal(request.headers.authorization, undefined);
        response.end('plain copy works');
      } },
    }));
    t.after(() => manual.dispose());
    const address = await manual.ready;
    const response = await wireRequest(address, '/gh/https://github.com/owner/repo');
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), 'plain copy works');
    assert.equal((await wireRequest(address, '/gh/')).status, 200);
    assert.equal((await wireRequest(address, '/gh')).status, 200);
  });
});
