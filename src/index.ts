// gh-proxy 的优化版 Cloudflare Worker
// 转换为 TypeScript 以获得更好的类型安全性和可维护性。

/**
 * 配置接口
 */
interface Env {
  // 使用环境变量进行配置
  ASSET_URL?: string;
  PREFIX?: string;
  JSDELIVR?: string; // "0" 或 "1"
  WHITE_LIST?: string; // 逗号分隔的白名单字符串
  GH_TOKEN?: string; // GitHub Personal Access Token (用于解决 API 限流问题)
}

// 默认配置
const DEFAULTS = {
  // 静态资源/前端页面地址。
  // 默认为空，使用本 Worker 内联的 HTML 页面（推荐）。
  ASSET_URL: '',
  
  // 路径前缀。
  // 如果您的 Worker 部署在子路径下（例如 example.com/gh/*），请将 PREFIX 改为 '/gh/'。
  // 注意：少一个杠都会导致错误！
  PREFIX: '/',
  
  // 是否使用 jsDelivr 加速文件下载（默认关闭，与原版一致）
  JSDELIVR: false, 

  // GitHub Personal Access Token (可选，建议只配置无权限 Token)
  // 用于解决 API 限流问题。如果环境变量中未配置，则使用此处的默认值。
  GH_TOKEN: '',
};

// GitHub 官方域名正则 (用于检测和白名单)
// 扩充域名列表以支持 releases (objects), avatars, assets, gist 等
const GITHUB_REGEX = /^(?:www\.)?(?:github\.com|gist\.github\.com|raw\.githubusercontent\.com|gist\.githubusercontent\.com|objects\.githubusercontent\.com|assets-cdn\.github\.com|avatars\.githubusercontent\.com|api\.github\.com)$/;

/**
 * 首页 HTML (内联，不依赖外部 URL)
 * 极简模式，普通页面显示，隐藏代理功能
 */
const HOME_PAGE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background-color: #f0f2f5; color: #333; }
        .container { text-align: center; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { margin: 0 0 10px; font-size: 24px; }
        p { margin: 0; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome</h1>
        <p>The service is running normally.</p>
    </div>
</body>
</html>
`;

/**
 * 静态白名单配置
 */
const staticWhiteList: string[] = []; 

/**
 * Worker 主入口点
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 优化：处理 favicon.ico，避免不必要的代理错误
    if (url.pathname === '/favicon.ico') {
        return new Response(null, { status: 204 });
    }

    // 优化：处理 robots.txt，禁止爬虫
    if (url.pathname === '/robots.txt') {
        return new Response("User-agent: *\nDisallow: /", { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      const requestAllowHeaders = request.headers.get('access-control-request-headers');
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
          'Access-Control-Allow-Headers': requestAllowHeaders || '*',
          'Access-Control-Max-Age': '1728000',
        }
      });
    }

    // 规范化前缀: 确保以 / 开头和结尾
    let prefix = env.PREFIX || DEFAULTS.PREFIX;
    if (!prefix.startsWith('/')) prefix = '/' + prefix;
    if (!prefix.endsWith('/')) prefix += '/';

    const assetUrl = env.ASSET_URL || DEFAULTS.ASSET_URL;
    const ghToken = env.GH_TOKEN || DEFAULTS.GH_TOKEN;

    // 防止循环重定向
    let safeAssetUrl = assetUrl;
    if (safeAssetUrl) {
        try {
            const assetObj = new URL(safeAssetUrl);
            if (assetObj.hostname === url.hostname || assetObj.hostname.includes('hunshcn.github.io')) {
                safeAssetUrl = ''; 
            }
        } catch (e) {
            safeAssetUrl = '';
        }
    }

    // 处理静态资源请求 (UI)
    // 逻辑优化：支持不带尾部斜杠的访问
    const prefixNoSlash = prefix.slice(0, -1);
    if (url.pathname === prefix || url.pathname === prefixNoSlash || url.pathname === prefix + 'index.html') {
      if (safeAssetUrl) {
          return Response.redirect(safeAssetUrl, 302);
      }
      return new Response(HOME_PAGE, {
        headers: { 'content-type': 'text/html;charset=UTF-8' },
      });
    }

    // 从请求 URL 解析目标路径
    let path = url.pathname + url.search;
    
    // 处理前缀 stripping
    if (prefix !== '/') {
      if (!path.startsWith(prefix)) {
        // 智能修正：尝试通过 Referer 修正 GitHub 页面子资源请求 (解决 spinning/commit error 问题)
        let handled = false;
        const referer = request.headers.get('Referer');
        if (referer) {
            try {
                const refererUrl = new URL(referer);
                // 检查 Referer 是否匹配当前 Worker 的前缀路径
                if (refererUrl.origin === url.origin && refererUrl.pathname.startsWith(prefix)) {
                    // 如果 Referer 是本站且带有前缀，说明是页面内部发起的请求
                    // 提取 Referer 指向的真实目标路径
                    let refererTarget = refererUrl.pathname.substring(prefix.length);
                    
                    // 补全协议 (如果 Referer 中的 URL 省略了协议)
                    if (!refererTarget.startsWith('http')) {
                         if (refererTarget.match(/^(?:github|raw|gist)\./)) {
                             refererTarget = 'https://' + refererTarget;
                         }
                    }

                    // 尝试解析 Referer 目标 URL
                    // 如果 refererTarget 是无效 URL (比如只有路径)，new URL 会报错，进入 catch
                    const refererTargetUrl = new URL(refererTarget);
                    
                    // 确认 Referer 目标是 GitHub 相关域名
                    if (GITHUB_REGEX.test(refererTargetUrl.hostname)) {
                        // 构造新的目标 URL: Referer 的 Origin + 当前请求的 Path
                        // 例如: https://github.com + /user/repo/tree-commit/hash
                        path = refererTargetUrl.origin + path;
                        handled = true;
                    }
                }
            } catch (e) {
                // 如果标准的 URL 解析失败，尝试降级匹配
                // 场景：用户可能访问的是无协议链接，且逻辑复杂
                try {
                    const refererUrl = new URL(referer);
                    if (refererUrl.origin === url.origin && refererUrl.pathname.startsWith(prefix)) {
                         const refererTarget = refererUrl.pathname.substring(prefix.length);
                         if (refererTarget.match(/^(https?:\/\/)?(www\.)?github\.com/)) {
                             path = 'https://github.com' + path;
                             handled = true;
                         }
                    }
                } catch (e2) {}
            }
        }

        if (!handled) {
            // 如果请求看起来像 API 请求 (Accept: application/json 或包含 github 路径特征)，则不要返回首页 HTML
            // 这能避免前端 JS 解析 HTML 报错，虽然返回 404 也是错，但比 JSON 解析错误更清晰
            const accept = request.headers.get('Accept') || '';
            const isApiRequest = accept.includes('application/json') || 
                                 !!path.match(/^(?:\/)?(api|graphql|users|orgs|repos)\//) ||
                                 !!path.match(/\.(js|css|json|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/);

            if (isApiRequest) {
                 return new Response('Not Found (Invalid Prefix)', { status: 404 });
            }

            // 路径不匹配前缀，重定向到首页
            if (safeAssetUrl) {
                return Response.redirect(safeAssetUrl, 302);
            }
            return new Response(HOME_PAGE, {
                headers: { 'content-type': 'text/html;charset=UTF-8' },
            });
        }
      } else {
        path = path.substring(prefix.length);
      }
    } else {
      path = path.substring(1); // 移除开头的斜杠
    }

    // 检查路径是否为空 (处理根路径请求)
    if (!path) {
      if (safeAssetUrl) {
          return Response.redirect(safeAssetUrl, 302);
      }
      return new Response(HOME_PAGE, {
          headers: { 'content-type': 'text/html;charset=UTF-8' },
      });
    }

    // 优化：处理 git clone 的特殊情况
    // 如果缺少协议则添加
    if (!path.startsWith('http')) {
        if (path.match(/^(?:github|raw|gist)\./)) {
             path = 'https://' + path;
        } else {
             // 默认尝试 https
             path = 'https://' + path;
        }
    }
    
    // 优化：处理 https:/github.com 这种少写斜杠的情况 (类似于原版 replace(/^https?:\/+/, 'https://'))
    path = path.replace(/^https?:\/+/, 'https://');

    // 标准化 URL
    let targetUrl: URL;
    try {
        targetUrl = new URL(path);
    } catch (e) {
        return new Response('Invalid URL', { status: 400 });
    }

    // --- 白名单检查 ---
    const envWhiteList = env.WHITE_LIST ? env.WHITE_LIST.split(',').filter(x => x).map(x => x.trim()) : [];
    const fullWhiteList = [...staticWhiteList, ...envWhiteList];

    if (fullWhiteList.length > 0) {
      const isAllowed = fullWhiteList.some(item => targetUrl.pathname.includes(item) || targetUrl.hostname.includes(item));
      if (!isAllowed) {
        return new Response('Forbidden: path not in whitelist', { status: 403 });
      }
    }

    // --- 核心逻辑 ---
    // 识别 GitHub URL 的类型
    const isGitHub = targetUrl.hostname === 'github.com' || targetUrl.hostname === 'www.github.com';
    const isRaw = targetUrl.hostname === 'raw.githubusercontent.com';
    const isGist = targetUrl.hostname === 'gist.githubusercontent.com';
    const isGistUI = targetUrl.hostname === 'gist.github.com';
    const isApi = targetUrl.hostname === 'api.github.com';

    // 如果不是 GitHub URL，且没有配置 ASSET_URL，则拒绝
    if (!isGitHub && !isRaw && !isGist && !isGistUI && !isApi) {
         // 非 GitHub 请求回退到 ASSET_URL (如果配置了)
         // 注意：这里可能被用作通用代理，如果 ASSET_URL 是外部站点。
         // 但如果 ASSET_URL 为空（默认），则返回 404。
         const assetPath = path.replace(/^https?:\/\//, '');
         
         if (safeAssetUrl) {
             try {
                 const finalAssetUrl = new URL(assetPath, safeAssetUrl).toString();
                 return fetch(finalAssetUrl);
             } catch (e) {
                 return new Response('Invalid Asset URL', { status: 404 });
             }
         } else {
             return new Response('Not Found', { status: 404 });
         }
    }

    // 优化：处理 jsDelivr 重定向
    const useJsDelivr = (env.JSDELIVR || (DEFAULTS.JSDELIVR ? "1" : "0")) === "1";
    
    if (useJsDelivr) {
        // 匹配 blob
        const blobMatch = path.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
        if (blobMatch) {
            const newUrl = `https://cdn.jsdelivr.net/gh/${blobMatch[1]}/${blobMatch[2]}@${blobMatch[3]}/${blobMatch[4]}`;
            return Response.redirect(newUrl, 302);
        }

        // 匹配 raw
        const rawMatch = path.match(/^(?:https?:\/\/)?raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
        if (rawMatch) {
             const newUrl = `https://cdn.jsdelivr.net/gh/${rawMatch[1]}/${rawMatch[2]}@${rawMatch[3]}/${rawMatch[4]}`;
             return Response.redirect(newUrl, 302);
        }
    } else {
        // 优化：如果不使用 jsDelivr，将 GitHub blob 页面请求转换为 raw 请求
        if (isGitHub && targetUrl.pathname.includes('/blob/')) {
              targetUrl.hostname = 'raw.githubusercontent.com';
              targetUrl.pathname = targetUrl.pathname.replace('/blob/', '/');
        }
        
        // 优化：Gist UI 页面也转换为 raw (解决 Gist 乱码和无法直接下载问题)
        // 示例: https://gist.github.com/username/hash -> https://gist.githubusercontent.com/username/hash/raw/
        if (isGistUI) {
              targetUrl.hostname = 'gist.githubusercontent.com';
              // 确保路径末尾有 /raw/ (Gist Raw 格式通常是 /raw/文件名，如果不加文件名会自动重定向到最新文件)
              if (!targetUrl.pathname.includes('/raw')) {
                   targetUrl.pathname = targetUrl.pathname + '/raw/';
              }
        }
    }

    // 代理请求
    return proxyRequest(targetUrl.toString(), request, prefix, 0, ghToken);
  },
};

/**
 * 代理请求处理程序
 * @param url 目标 URL
 * @param originalRequest 原始请求
 * @param prefix 路径前缀
 * @param redirectCount 重定向计数 (防止死循环)
 * @param ghToken GitHub Personal Access Token
 */
async function proxyRequest(url: string, originalRequest: Request, prefix: string, redirectCount: number = 0, ghToken?: string): Promise<Response> {
  // 防止无限重定向
  if (redirectCount > 5) {
      return new Response('Too many redirects', { status: 502 });
  }

  const headers = new Headers(originalRequest.headers);
  
  // 清理请求头
  headers.delete('Host');
  headers.delete('Referer'); // 隐私
  headers.delete('Origin');
  headers.delete('Cookie'); // 隐私
  headers.delete('cf-connecting-ip');
  headers.delete('x-forwarded-for');
  headers.delete('connection');
  
  if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'Mozilla/5.0 (compatible; gh-proxy/1.0)');
  }

  // 优化：处理 API Rate Limit (API 限流)
  // 如果环境变量中配置了 GH_TOKEN，且请求中没有 Authorization 头，则自动添加
  if (ghToken && !headers.has('Authorization')) {
      headers.set('Authorization', `token ${ghToken}`);
  }

  try {
    const response = await fetch(url, {
      method: originalRequest.method,
      headers: headers,
      body: originalRequest.body,
      redirect: 'manual', // 手动处理重定向
    });

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS');
    newHeaders.set('Access-Control-Allow-Headers', '*');
    newHeaders.set('Access-Control-Expose-Headers', '*'); // 原版有这个
    
    // 移除 CSP 和 Clear-Site-Data (防止 GitHub 的安全策略影响代理后的页面)
    newHeaders.delete('content-security-policy');
    newHeaders.delete('content-security-policy-report-only');
    newHeaders.delete('clear-site-data');
    
    // 优化：移除可能导致协议错误的响应头 (解决 git clone 报错 RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly)
    // Cloudflare Worker 会自动处理 content-encoding 和 transfer-encoding，如果透传会导致客户端解析错误
    newHeaders.delete('content-encoding');
    newHeaders.delete('content-length');
    newHeaders.delete('transfer-encoding');
    newHeaders.delete('connection');
    newHeaders.delete('keep-alive');

    // 解决 Gist 或 Raw 文件中文乱码问题
    // 如果是文本类型且没有指定 charset，强制添加 charset=utf-8
    const contentType = newHeaders.get('content-type');
    if (contentType && contentType.startsWith('text/') && !contentType.includes('charset')) {
        newHeaders.set('content-type', contentType + '; charset=utf-8');
    }

    // 处理重定向
    if (newHeaders.has('Location')) {
        const location = newHeaders.get('Location');
        if (location) {
            try {
                // 解析重定向目标
                const locUrl = new URL(location, url);
                
                // 检查是否是 GitHub 官方域名
                const isGitHub = GITHUB_REGEX.test(locUrl.hostname);
                
                if (isGitHub) {
                    // 如果是 GitHub 重定向，重写 Location 为代理地址
                    // 确保 prefix 格式正确（如果 prefix 是 /，则直接拼接）
                    // 逻辑：Location: https://github.com/foo -> /gh/https://github.com/foo
                    newHeaders.set('Location', prefix + locUrl.toString());
                } else {
                    // 如果是外部重定向（例如 S3, 非 GitHub），则在 Worker 内部跟随跳转（代理）
                    // 这保持了“不作为通用代理”的原则（只有 GitHub 的跳转才被允许作为代理结果返回）
                    // 但为了避免滥用，我们只跟随，不返回 302 给用户让用户去访问外部
                    return proxyRequest(locUrl.toString(), originalRequest, prefix, redirectCount + 1, ghToken);
                }
            } catch (e) {
                console.error('Redirect parse error:', e);
            }
        }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (err: any) {
    return new Response(`Error fetching ${url}: ${err.message}`, { status: 502 });
  }
}
