// gh-proxy 优化版 Cloudflare Worker (纯 JavaScript 版本)
// 如果你不需要 TypeScript，可以直接复制此文件内容到 Cloudflare Worker 编辑器中。

/**
 * 静态白名单配置
 * 在此处添加路径或用户名。只有匹配这些的请求才会被允许。
 * 留空则允许所有请求。
 * 示例: ['/username/', '/repo-name/']
 */
const staticWhiteList = []; 

// 默认配置
const DEFAULTS = {
    // 静态资源/前端页面地址。
    // 默认为空，使用本 Worker 内联的 HTML 页面（推荐）。
    ASSET_URL: '',
    
    // 路径前缀。
    // 如果您的 Worker 部署在子路径下（例如 example.com/gh/*），请将 PREFIX 改为 '/gh/'。
    // 注意：少一个杠都会导致错误！
    PREFIX: '/',
    
    // 是否使用 jsDelivr 加速文件下载（默认关闭）
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

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 优化：处理 favicon.ico
        if (url.pathname === '/favicon.ico') {
            return new Response(null, { status: 204 });
        }
        
        // 优化：处理 robots.txt
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

        // 兼容 env 对象（Cloudflare Worker）或使用默认值
        let prefix = (env && env.PREFIX) || DEFAULTS.PREFIX;
        // 规范化前缀: 确保以 / 开头和结尾
        if (!prefix.startsWith('/')) prefix = '/' + prefix;
        if (!prefix.endsWith('/')) prefix += '/';

        const assetUrl = (env && env.ASSET_URL) || DEFAULTS.ASSET_URL;
        const jsDelivr = (env && env.JSDELIVR) || (DEFAULTS.JSDELIVR ? "1" : "0");
        const ghToken = (env && env.GH_TOKEN) || DEFAULTS.GH_TOKEN;

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
                headers: { 'content-type': 'text/html;charset=UTF-8' }
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
                            const refererTargetUrl = new URL(refererTarget);
                            
                            // 确认 Referer 目标是 GitHub 相关域名
                            if (GITHUB_REGEX.test(refererTargetUrl.hostname)) {
                                // 构造新的目标 URL: Referer 的 Origin + 当前请求的 Path
                                path = refererTargetUrl.origin + path;
                                handled = true;
                            }
                        }
                    } catch (e) {
                         // 如果标准的 URL 解析失败，尝试降级匹配
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
                    const accept = request.headers.get('Accept') || '';
                    const isApiRequest = accept.includes('application/json') || 
                                         !!path.match(/^(?:\/)?(api|graphql|users|orgs|repos)\//) ||
                                         !!path.match(/\.(js|css|json|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/);
        
                    if (isApiRequest) {
                         return new Response('Not Found (Invalid Prefix)', { status: 404 });
                    }

                    if (safeAssetUrl) {
                        return Response.redirect(safeAssetUrl, 302);
                    }
                    return new Response(HOME_PAGE, {
                        headers: { 'content-type': 'text/html;charset=UTF-8' }
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
                headers: { 'content-type': 'text/html;charset=UTF-8' }
            });
        }

        // 优化：处理 git clone 的特殊情况
        // 如果缺少协议则添加
        if (!path.startsWith('http')) {
            // 如果看起来像域名，添加 https://
            if (path.match(/^(?:github|raw|gist)\./)) {
                path = 'https://' + path;
            } else {
                path = 'https://' + path;
            }
        }

        // 优化：处理 https:/github.com 这种少写斜杠的情况
        path = path.replace(/^https?:\/+/, 'https://');

        // 标准化 URL
        let targetUrl;
        try {
            targetUrl = new URL(path);
        } catch (e) {
            return new Response('Invalid URL', { status: 400 });
        }

        // --- 白名单检查 ---
        const envWhiteList = (env && env.WHITE_LIST) ? env.WHITE_LIST.split(',').filter(x => x).map(x => x.trim()) : [];
        const fullWhiteList = [...staticWhiteList, ...envWhiteList];

        if (fullWhiteList.length > 0) {
            const isAllowed = fullWhiteList.some(item => targetUrl.pathname.includes(item) || targetUrl.hostname.includes(item));
            if (!isAllowed) {
                return new Response('Forbidden: path not in whitelist', { status: 403 });
            }
        }

        // --- 核心逻辑 ---
        const isGitHub = targetUrl.hostname === 'github.com' || targetUrl.hostname === 'www.github.com';
        const isRaw = targetUrl.hostname === 'raw.githubusercontent.com';
        const isGist = targetUrl.hostname === 'gist.githubusercontent.com';
        const isGistUI = targetUrl.hostname === 'gist.github.com';
        const isApi = targetUrl.hostname === 'api.github.com';

        if (!isGitHub && !isRaw && !isGist && !isGistUI && !isApi) {
            // 非 GitHub 请求回退到 ASSET_URL
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
        if (jsDelivr === "1") {
            const blobMatch = path.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
            if (blobMatch) {
                const newUrl = `https://cdn.jsdelivr.net/gh/${blobMatch[1]}/${blobMatch[2]}@${blobMatch[3]}/${blobMatch[4]}`;
                return Response.redirect(newUrl, 302);
            }

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
            if (isGistUI) {
                  targetUrl.hostname = 'gist.githubusercontent.com';
                  if (!targetUrl.pathname.includes('/raw')) {
                       targetUrl.pathname = targetUrl.pathname + '/raw/';
                  }
            }
        }

        // 代理请求
        return proxyRequest(targetUrl.toString(), request, prefix, 0, ghToken);
    }
};

/**
 * 代理请求处理程序
 * @param url 目标 URL
 * @param originalRequest 原始请求
 * @param prefix 路径前缀
 * @param redirectCount 重定向计数 (防止死循环)
 * @param ghToken GitHub Personal Access Token
 */
async function proxyRequest(url, originalRequest, prefix, redirectCount = 0, ghToken = null) {
    // 防止无限重定向
    if (redirectCount > 5) {
        return new Response('Too many redirects', { status: 502 });
    }

    const headers = new Headers(originalRequest.headers);

    headers.delete('Host');
    headers.delete('Referer');
    headers.delete('Origin');
    headers.delete('Cookie');
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
            redirect: 'manual',
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
                    const locUrl = new URL(location, url);
                    
                    // 检查是否是 GitHub 官方域名
                    const isGitHub = GITHUB_REGEX.test(locUrl.hostname);
                    
                    if (isGitHub) {
                        newHeaders.set('Location', prefix + locUrl.toString());
                    } else {
                         // 如果是外部重定向（例如 S3, 非 GitHub），则在 Worker 内部跟随跳转（代理）
                        return proxyRequest(locUrl.toString(), originalRequest, prefix, redirectCount + 1, ghToken);
                    }
                } catch (e) {}
            }
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
        });
    } catch (err) {
        return new Response(`Error fetching ${url}: ${err.message}`, { status: 502 });
    }
}
