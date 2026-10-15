// gh-proxy 优化版 Cloudflare Worker（可直接复制的 JavaScript 源码）
// 修改下面的「用户配置区」，然后全选复制到 Cloudflare Worker 编辑器即可部署。
// 不需要安装 Node.js，也不需要配置环境变量；同名环境变量仅在设置后覆盖这里的值。

// ==================== 用户配置区：通常只需修改这里 ====================

const DEFAULTS = {
  // 1. 路径前缀：按原来的用法，默认使用 /gh/。
  // 示例：https://你的域名/gh/https://github.com/用户名/仓库/...
  // 如果希望直接使用「域名/https://github.com/...」，改成 '/' 即可。
  PREFIX: '/gh/',

  // 2. 首页跳转地址：留空显示内置 Welcome 页面。
  // 如果希望首页跳转到其他网站，可填写 'https://example.com'。
  ASSET_URL: '',

  // 3. 访问白名单：留空表示不限制 GitHub/GitLab 路径。
  // 多个关键词用英文逗号分隔，例如 '/username/repo/,/another/repo/'。
  WHITE_LIST: '',

  // 4. GitHub Token（可选）：普通文件下载、Release 和 git clone 不需要填写。
  // 仅在 GitHub API 限流时使用，并且只自动用于 API 的 GET/HEAD 请求。
  // 可以在 Worker 编辑器里填写；不要把真实 Token 提交到公开仓库。
  // 如果选择在 Cloudflare 设置中配置 GH_TOKEN，建议将其保存为 Secret。
  GH_TOKEN: '',

  // 5. 等待上游响应头的超时，单位为毫秒；30000 表示 30 秒。
  // 包含上传和跳转时间；收到响应头后，大文件下载不会被此期限中断。
  // 有效范围为 1000–120000，一般保持默认即可。
  UPSTREAM_TIMEOUT_MS: 30000,
};

// ==================== 用户配置区结束 ====================
// 以下是代理功能代码。修改日常配置时，不需要改动下面的逻辑。

/**
 * 可选的 Cloudflare 环境变量；未设置时使用上面的 DEFAULTS。
 * @typedef {Object} Env
 * @property {string} [ASSET_URL]
 * @property {string} [PREFIX]
 * @property {string} [WHITE_LIST]
 * @property {string} [GH_TOKEN]
 * @property {string | number} [UPSTREAM_TIMEOUT_MS]
 */

// 仅代理这些完整域名。每次跳转也会检查，避免变成任意网站的开放代理。
const ALLOWED_HOSTS = new Set([
  'git.io', 'gitlab.com',
  'github.com', 'www.github.com', 'api.github.com', 'codeload.github.com',
  'raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com', 'media.githubusercontent.com',
  'avatars.githubusercontent.com', 'assets-cdn.github.com', 'github.githubassets.com',
  'user-images.githubusercontent.com', 'private-user-images.githubusercontent.com',
  'github-production-release-asset-2e65be.s3.amazonaws.com',
]);

// 客户端自带的 Authorization 只传给以下代码托管服务，不传给短链或附件下载域名。
const AUTH_HOSTS = new Set([
  'gitlab.com',
  'github.com', 'www.github.com', 'api.github.com',
  'raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com',
]);

// GitLab 的专用鉴权头仅能发送给 gitlab.com，跨域跳转时与 Authorization 一起清除。
const GITLAB_AUTH_HEADERS = ['private-token', 'job-token', 'deploy-token'];
const GITLAB_QUERY_TOKENS = ['private_token', 'access_token', 'job_token', 'deploy_token'];

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOW_METHODS = METHODS.join(', ');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// 连接管理头由 Cloudflare 处理，不直接转发给下一跳。
const HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

// 清理本站 Cookie、来源地址及客户端转发信息。
const PRIVATE_HEADERS = [
  'host', 'cookie', 'referer', 'origin', 'forwarded', 'x-real-ip',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'cf-connecting-ip', 'cf-connecting-ipv6', 'true-client-ip', 'cf-ipcountry',
  'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret',
];

const RESPONSE_HEADERS_TO_REMOVE = [
  'set-cookie', 'clear-site-data', 'content-security-policy', 'content-security-policy-report-only',
];

// 内置首页：如需修改 Welcome 文字或页面样式，可以修改这一段 HTML。
const HOME_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f0f2f5;
      color: #333;
    }
    main {
      text-align: center;
      padding: 20px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px #0002;
    }
    h1 { margin: 0 0 10px; font-size: 24px; }
    p { margin: 0; color: #666; }
  </style>
</head>
<body>
  <main>
    <h1>Welcome</h1>
    <p>The service is running normally.</p>
  </main>
</body>
</html>`;

// -------------------- 响应和 URL 处理 --------------------

/**
 * 统一添加跨域响应头。
 * @param {Headers} headers
 */
function cors(headers) {
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', '*');
  headers.delete('access-control-allow-credentials');
  return headers;
}

/**
 * 生成本地响应；HEAD 请求不返回正文，错误响应不缓存。
 * @param {Request} request
 * @param {string | null} body
 * @param {number} [status]
 * @param {HeadersInit} [init]
 */
function reply(request, body, status = 200, init = {}) {
  const headers = cors(new Headers(init));

  if (!headers.has('content-type') && body !== null) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }
  if (status >= 400) {
    headers.set('cache-control', 'no-store');
  }

  return new Response(request.method === 'HEAD' ? null : body, { status, headers });
}

/**
 * 限制目标为受信任的 HTTPS 地址，不允许内嵌密码或自定义端口。
 * @param {URL | null} url
 * @returns {url is URL}
 */
function allowed(url) {
  return url !== null && url.protocol === 'https:' && !url.port &&
    !url.username && !url.password && ALLOWED_HOSTS.has(url.hostname);
}

/**
 * 查询参数不参与白名单匹配；git.io 短链使用解析后的目标进行此检查。
 * @param {URL} url
 * @param {Env} env
 */
function pathAllowed(url, env) {
  const configured = env.WHITE_LIST ?? DEFAULTS.WHITE_LIST;
  if (!configured) return true;
  const whitelist = configured.split(',').map(item => item.trim()).filter(Boolean);
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 非法编码按原始路径匹配。
  }
  return !whitelist.length || whitelist.some(item => pathname.includes(item) || url.hostname.includes(item));
}

/**
 * 补全协议，并兼容整个 URL 被编码一次的情况。
 * @param {string} value
 */
function parseTarget(value) {
  try {
    // 只解码完整编码的 URL，避免破坏普通文件名和 Release 下载签名。
    if (/^https?%3a/i.test(value)) {
      value = decodeURIComponent(value);
    }
    if (/^https?:/i.test(value)) {
      value = value.replace(/^https?:\/*/i, 'https://');
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
      value = 'https://' + value;
    }

    const url = new URL(value);
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

/**
 * 根据本站代理页面的来源地址，修正部分根路径资源请求。
 * @param {Request} request
 * @param {URL} url
 * @param {string} prefix
 */
function fromReferer(request, url, prefix) {
  const value = request.headers.get('referer');
  if (!value) return null;

  try {
    const referer = new URL(value);
    if (referer.origin !== url.origin || !referer.pathname.startsWith(prefix)) {
      return null;
    }

    const target = parseTarget(referer.pathname.slice(prefix.length));
    return allowed(target) ? new URL(target.origin + url.pathname + url.search) : null;
  } catch {
    return null;
  }
}

/**
 * 将 GitHub/GitLab blob 和 Gist 文件页面转成 Raw 下载地址。
 * @param {URL} url
 */
function fileTarget(url) {
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (blob) {
      url.hostname = 'raw.githubusercontent.com';
      url.pathname = `/${blob[1]}/${blob[2]}/${blob[3]}`;
    }
  } else if (url.hostname === 'gitlab.com') {
    // 第一个 /-/ 分隔项目和操作；保留子组、分支和文件名中后续的 /-/blob/。
    const separator = url.pathname.indexOf('/-/');
    if (separator > 0 && url.pathname.startsWith('/-/blob/', separator)) {
      url.pathname = url.pathname.slice(0, separator) + '/-/raw/' + url.pathname.slice(separator + 8);
    }
  } else if (url.hostname === 'gist.github.com') {
    const gist = /^\/([^/]+)\/([a-f\d]+)(?:\/([a-f\d]+))?\/?$/i.exec(url.pathname);
    if (gist) {
      url.hostname = 'gist.githubusercontent.com';
      url.pathname = `/${gist[1]}/${gist[2]}/raw/${gist[3] ? gist[3] + '/' : ''}`;
    } else if (/^\/[^/]+\/[a-f\d]+\/raw(?:\/|$)/i.test(url.pathname)) {
      url.hostname = 'gist.githubusercontent.com';
    }
  }
  return url;
}

/**
 * 清理固定的逐跳头，以及 Connection 头额外指定的字段。
 * @param {Headers} headers
 */
function stripHopHeaders(headers) {
  for (const value of (headers.get('connection') || '').split(',')) {
    const name = value.trim();
    if (/^[\w!#$%&'*+.^`|~-]+$/.test(name)) {
      headers.delete(name);
    }
  }
  for (const name of HOP_HEADERS) {
    headers.delete(name);
  }
}

/**
 * 保留下载大小、压缩、Range 和 ETag 等信息；鉴权响应禁止共享缓存。
 * @param {Response} response
 * @param {boolean} authenticated
 */
function responseHeaders(response, authenticated) {
  const headers = new Headers(response.headers);
  stripHopHeaders(headers);

  for (const name of RESPONSE_HEADERS_TO_REMOVE) {
    headers.delete(name);
  }
  headers.set('strict-transport-security', 'max-age=31536000');

  if (authenticated) {
    headers.set('cache-control', 'private, no-store');
    headers.delete('expires');
    headers.delete('surrogate-control');
  }
  return cors(headers);
}

/**
 * 取消不再使用的跳转响应体，及时释放连接。
 * @param {Response} response
 */
async function discard(response) {
  await response.body?.cancel().catch(() => {});
}

// -------------------- GitHub 网页路径适配 --------------------

// 仅注入到浏览器打开的 GitHub HTML 页面；文件、API 和 Git 数据不经过这里。
// GitHub 的路由器从 document.defaultView 读取路径，需要看到 /用户名/仓库，
// 而地址栏、实际请求和历史记录仍然保留 /gh/https://github.com/ 前缀。
const PAGE_ADAPTER = String.raw`(prefix, initialTarget, hosts) => {
  const origin = location.origin;
  const allowedHosts = new Set(hosts);
  const replaceState = history.replaceState.bind(history);
  replaceState(history.state, '', prefix + initialTarget + location.hash);

  function upstreamLocation() {
    return new URL(location.pathname.slice(prefix.length) + location.search + location.hash);
  }

  function pageLocation() {
    const upstream = upstreamLocation();
    return new URL(upstream.pathname + upstream.search + upstream.hash, origin);
  }

  function proxyURL(value) {
    const url = new URL(value, pageLocation());
    if (url.origin === origin) {
      if (url.pathname.startsWith(prefix + 'https://')) return url.href;
      const upstream = upstreamLocation();
      url.protocol = upstream.protocol;
      url.host = upstream.host;
      url.port = upstream.port;
    }
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && allowedHosts.has(url.hostname)
      ? origin + prefix + url.href : url.href;
  }

  // React/Turbo 的前端跳转也必须写入完整代理地址，刷新、前进和后退才能继续使用。
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name].bind(history);
    history[name] = (state, unused, url) => original(state, unused, url == null ? url : proxyURL(url));
  }

  const view = new Proxy(window, {
    get(target, key) {
      if (key === 'location') return pageLocation();
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' && !Object.hasOwn(value, 'prototype') ? value.bind(target) : value;
    },
  });
  Object.defineProperty(document, 'defaultView', { configurable: true, get: () => view });

  // 提交说明、分支数量和目录内容通过后续请求加载，不能只改写静态 HTML 链接。
  // 在 Request 创建前转换地址，保留字符串/Blob 请求体，避免克隆后变成仅 HTTP/2 支持的流式上传。
  const NativeRequest = window.Request;
  window.Request = new Proxy(NativeRequest, {
    construct(target, args, newTarget) {
      if (!(args[0] instanceof NativeRequest)) args[0] = proxyURL(args[0]);
      return Reflect.construct(target, args, newTarget);
    },
  });
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (!(input instanceof NativeRequest)) return originalFetch(proxyURL(input), init);
    const url = proxyURL(input.url);
    return originalFetch(url === input.url ? input : new NativeRequest(url, input), init);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    args[1] = proxyURL(args[1]);
    return Reflect.apply(originalOpen, this, args);
  };

  // React 后续生成的链接和表单同样保留代理路径，支持普通点击及新标签页打开。
  function rewriteLink(event) {
    const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
    if (link) link.setAttribute('href', proxyURL(link.getAttribute('href')));
  }
  document.addEventListener('click', rewriteLink, true);
  document.addEventListener('auxclick', rewriteLink, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) form.action = proxyURL(form.getAttribute('action') || pageLocation().href);
    if (event.submitter?.hasAttribute('formaction')) event.submitter.formAction = proxyURL(event.submitter.getAttribute('formaction'));
  }, true);
}`;

/**
 * @param {Request} request
 * @param {URL} target
 */
function isPageRequest(request, target) {
  const destination = request.headers.get('sec-fetch-dest');
  return request.method === 'GET' && ['github.com', 'www.github.com'].includes(target.hostname) &&
    request.headers.get('accept')?.includes('text/html') && !request.headers.has('range') &&
    (!destination || destination === 'document' || destination === 'iframe');
}

/**
 * 流式改写网页并在 GitHub 脚本之前注入路径适配，不读取整个响应体。
 * @param {Response} response
 * @param {Request} request
 * @param {URL} target
 * @param {string} prefix
 */
function adaptPage(response, request, target, prefix) {
  if (!isPageRequest(request, target) || response.status !== 200 || !response.body ||
      !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '') ||
      response.headers.has('content-disposition') ||
      /\bbr\b/i.test(response.headers.get('content-encoding') || '')) {
    return response;
  }

  // 内容已改变，不能继续使用原 HTML 的压缩大小、校验值或范围信息。
  for (const name of ['content-encoding', 'content-length', 'etag', 'last-modified', 'content-md5', 'digest', 'accept-ranges']) {
    response.headers.delete(name);
  }
  response.headers.set('cache-control', 'no-store');

  const config = JSON.stringify([prefix, target.href, [...ALLOWED_HOSTS]]).replace(/</g, '\\u003c');
  const script = `<script>(${PAGE_ADAPTER})(...${config});</script>`;
  const origin = new URL(request.url).origin;
  return new HTMLRewriter()
    .on('head', { element(element) { element.prepend(script, { html: true }); } })
    .on('a[href], area[href], link[href], script[src], img[src], source[src], form[action], input[src], video[poster]', {
      element(element) {
        for (const name of ['href', 'src', 'action', 'poster']) {
          const value = element.getAttribute(name);
          if (value === null) continue;
          try {
            const url = new URL(value, target);
            if (allowed(url)) element.setAttribute(name, origin + prefix + url.href);
          } catch {
            // 保留无效或不受支持的地址，由浏览器按原页面处理。
          }
        }
      },
    }).transform(response);
}

// -------------------- 代理传输 --------------------

/**
 * 流式转发请求和响应，不把大文件整体读入内存。
 * @param {URL} target
 * @param {Request} request
 * @param {Env} env
 * @param {string} prefix
 */
async function proxy(target, request, env, prefix) {
  if (request.signal.aborted) {
    return reply(request, 'Client closed request', 499);
  }

  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  const headers = new Headers(request.headers);
  stripHopHeaders(headers);
  for (const name of PRIVATE_HEADERS) {
    headers.delete(name);
  }
  if (!AUTH_HOSTS.has(target.hostname)) {
    headers.delete('authorization');
  }
  if (target.hostname !== 'gitlab.com') {
    for (const name of GITLAB_AUTH_HEADERS) headers.delete(name);
  }

  // 环境变量优先；没有设置时，使用文件顶部填写的 Token。
  const ghToken = (env.GH_TOKEN ?? DEFAULTS.GH_TOKEN).trim();
  if (readOnly && target.hostname === 'api.github.com' && !headers.has('authorization') && ghToken) {
    try {
      headers.set('authorization', `Bearer ${ghToken}`);
    } catch {
      return reply(request, 'Invalid GH_TOKEN configuration', 500);
    }
  }
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'gh-proxy');
  }

  let authenticated = headers.has('authorization') || GITLAB_AUTH_HEADERS.some(name => headers.has(name));
  const acceptEncoding = headers.get('accept-encoding');
  const validators = {
    'if-none-match': headers.get('if-none-match'),
    'if-modified-since': headers.get('if-modified-since'),
  };

  const configuredTimeout = Number(env.UPSTREAM_TIMEOUT_MS ?? DEFAULTS.UPSTREAM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(120_000, Math.max(1_000, configuredTimeout)) : 30_000;
  const timeout = new AbortController();
  const signal = AbortSignal.any([request.signal, timeout.signal]);

  // 只限制收到最终响应头之前的等待；开始下载后清除定时器。
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects++) {
      authenticated ||= target.hostname === 'gitlab.com' && GITLAB_QUERY_TOKENS.some(name => target.searchParams.has(name));
      if (authenticated) headers.set('cache-control', 'no-store');
      const pageRequest = isPageRequest(request, target);
      // 旧兼容日期不能解码 Brotli HTML。页面协商 gzip，下载仍保留客户端的压缩协商。
      if (pageRequest) headers.set('accept-encoding', 'gzip');
      else if (acceptEncoding !== null) headers.set('accept-encoding', acceptEncoding);
      else headers.delete('accept-encoding');
      // 避免 304 让浏览器继续使用升级前、没有路径适配的 HTML 缓存。
      for (const [name, value] of Object.entries(validators)) {
        if (pageRequest || value === null) headers.delete(name);
        else headers.set(name, value);
      }
      const response = await fetch(target.href, {
        method: request.method,
        headers,
        body: readOnly ? undefined : request.body,
        redirect: 'manual',
        signal,
        // 使用旧兼容日期也支持的缓存控制方式；负 TTL 表示不缓存。
        ...(authenticated ? { cf: { cacheTtlByStatus: { '100-599': -1 } } } : {}),
      });

      const location = response.headers.get('location');
      if (REDIRECTS.has(response.status) && location) {
        /** @type {URL | null} */
        let next = null;
        try {
          next = parseTarget(new URL(location, target).href);
        } catch {
          // 无效的跳转地址会在下面统一拒绝。
        }

        if (!allowed(next)) {
          await discard(response);
          return reply(request, 'Upstream redirect target not allowed', 502);
        }
        if (target.hostname === 'git.io' && next.hostname !== 'git.io' && !pathAllowed(next, env)) {
          await discard(response);
          return reply(request, 'Forbidden: path not in whitelist', 403);
        }

        // 上传流不能重复读取，让 Git 等客户端自行按状态码处理重发。
        if (!readOnly) {
          // 不同上游仍共用本站域名，客户端可能重发鉴权；此时不能返回跨站上传跳转。
          if (authenticated && next.origin !== target.origin) {
            await discard(response);
            return reply(request, 'Authenticated cross-origin upload redirect not allowed', 502);
          }
          const outgoing = responseHeaders(response, authenticated);
          outgoing.set('location', prefix + next.href);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: outgoing,
          });
        }

        await discard(response);
        if (redirects >= MAX_REDIRECTS) {
          return reply(request, 'Too many redirects', 502);
        }

        next = fileTarget(next);
        if (next.origin !== target.origin || !AUTH_HOSTS.has(next.hostname)) {
          headers.delete('authorization');
          for (const name of GITLAB_AUTH_HEADERS) headers.delete(name);
        }
        target = next;
        continue;
      }

      // 下载保持原始流和压缩头；仅在浏览器请求 GitHub 网页时适配 HTML。
      return adaptPage(new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders(response, authenticated),
      }), request, target, prefix);
    }
  } catch {
    if (request.signal.aborted) {
      return reply(request, 'Client closed request', 499);
    }
    return timeout.signal.aborted
      ? reply(request, 'Upstream request timed out', 504)
      : reply(request, 'Upstream request failed', 502);
  } finally {
    clearTimeout(timer);
  }
}

// -------------------- Worker 请求入口 --------------------

export default {
  /**
   * @param {Request} request
   * @param {Env} [env]
   */
  async fetch(request, env = {}) {
    // 浏览器的跨域预检无需访问 GitHub。
    if (request.method === 'OPTIONS') {
      return reply(request, null, 204, {
        'access-control-allow-methods': ALLOW_METHODS,
        'access-control-allow-headers': request.headers.get('access-control-request-headers') || 'Authorization, Content-Type, Range, Git-Protocol, Private-Token, Job-Token, Deploy-Token',
        'access-control-max-age': '86400',
      });
    }
    if (!METHODS.includes(request.method)) {
      return reply(request, 'Method not allowed', 405, { allow: ALLOW_METHODS });
    }

    // 默认读取顶部配置；自动处理前缀首尾空格和斜杠。
    const url = new URL(request.url);
    const configuredPrefix = (env.PREFIX ?? DEFAULTS.PREFIX).trim().replace(/^\/+|\/+$/g, '');
    const prefix = configuredPrefix ? `/${configuredPrefix}/` : '/';

    if (url.pathname === '/favicon.ico' || url.pathname === prefix + 'favicon.ico') {
      return reply(request, null, 204);
    }
    if (url.pathname === '/robots.txt' || url.pathname === prefix + 'robots.txt') {
      return reply(request, 'User-agent: *\nDisallow: /\n');
    }

    // 首页既支持 /gh/，也支持省略末尾斜杠的 /gh。
    if (url.pathname === '/' || url.pathname === prefix || url.pathname === prefix.slice(0, -1) || url.pathname === prefix + 'index.html') {
      const assetUrl = env.ASSET_URL ?? DEFAULTS.ASSET_URL;
      if (assetUrl) {
        try {
          const asset = new URL(assetUrl);
          if (['https:', 'http:'].includes(asset.protocol) && !asset.username && !asset.password && asset.hostname !== url.hostname) {
            return reply(request, null, 302, { location: asset.href });
          }
        } catch {
          // 首页地址填错时继续显示内置页面，不影响文件代理。
        }
      }
      return reply(request, HOME_PAGE, 200, { 'content-type': 'text/html; charset=utf-8' });
    }

    // 去掉 /gh/ 等前缀后，剩余部分就是需要代理的地址。
    const inPrefix = url.pathname.startsWith(prefix);
    const path = inPrefix ? url.pathname.slice(prefix.length) + url.search : '';
    let target = inPrefix ? parseTarget(path) : null;
    if (!allowed(target) && !/^[a-z][a-z\d+.-]*(?::|%3a)/i.test(path)) {
      target = fromReferer(request, url, prefix);
    }
    if (!allowed(target)) {
      return reply(request, inPrefix ? 'Invalid or unsupported target URL' : 'Not Found (Invalid Prefix)', inPrefix ? 400 : 404);
    }

    // 短链先解析，再检查真实仓库路径；其他请求立即检查白名单。
    if (target.hostname !== 'git.io' && !pathAllowed(target, env)) {
      return reply(request, 'Forbidden: path not in whitelist', 403);
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      target = fileTarget(target);
    }
    return proxy(target, request, env, prefix);
  },
};
