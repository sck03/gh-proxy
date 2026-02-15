'use strict'

/**
 * static files (404.html, sw.js, conf.js)
 */
const ASSET_URL = '' // 默认为空，使用内联 HTML
const HOME_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GitHub 文件加速</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f6f8fa; color: #24292e; }
        .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 90%; max-width: 600px; text-align: center; }
        h1 { margin-bottom: 1.5rem; color: #24292e; }
        .input-group { display: flex; margin-bottom: 1.5rem; gap: 10px; }
        input { flex: 1; padding: 10px; border: 1px solid #d1d5da; border-radius: 6px; font-size: 16px; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: #0366d6; box-shadow: 0 0 0 3px rgba(3,102,214,0.3); }
        button { padding: 10px 20px; background-color: #2ea44f; color: white; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; font-weight: 600; transition: background-color 0.2s; }
        button:hover { background-color: #2c974b; }
        p { margin-bottom: 0.5rem; color: #586069; }
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .example { margin-top: 2rem; text-align: left; background: #f6f8fa; padding: 1rem; border-radius: 6px; font-size: 14px; }
        code { background: rgba(27,31,35,0.05); padding: 0.2em 0.4em; border-radius: 3px; font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; word-break: break-all; }
        .footer { margin-top: 2rem; font-size: 12px; color: #6a737d; }
    </style>
</head>
<body>
    <div class="container">
        <h1>GitHub 文件加速</h1>
        <div class="input-group">
            <input type="text" id="urlInput" placeholder="输入 GitHub 文件链接..." onkeypress="if(event.keyCode===13) jump()">
            <button onclick="jump()">跳转</button>
        </div>
        <div class="input-group" id="resultGroup" style="display:none;">
             <input type="text" id="resultInput" readonly>
             <button onclick="copyResult()">复制</button>
        </div>
        <p>支持 Release、Archive 以及项目文件加速。</p>
        <p>Git Clone 加速：</p>
        <code id="git-clone-cmd">git clone https://...</code>
        
        <div class="example">
            <p><strong>合法输入示例：</strong></p>
            <p>分支源码：<code>https://github.com/username/project/archive/master.zip</code></p>
            <p>Release：<code>https://github.com/username/project/releases/download/v1.0/file.zip</code></p>
            <p>分支文件：<code>https://github.com/username/project/blob/master/file.txt</code></p>
        </div>
        <div class="footer">
            Powered by Cloudflare Workers | Optimized gh-proxy
        </div>
    </div>
    <script>
        // 动态设置 Git Clone 示例，自动检测当前路径
        const currentUrl = location.href.split('?')[0];
        const baseUrl = currentUrl.endsWith('/') ? currentUrl : currentUrl + '/';
        document.getElementById('git-clone-cmd').innerText = 'git clone ' + baseUrl + 'https://github.com/username/repo.git';

        function jump() {
            var url = document.getElementById('urlInput').value;
            if (!url) return;
            // 确保是 GitHub 链接
            if (!url.match(/^(https?:\/\/)?(www\.)?(github\.com|raw\.githubusercontent\.com|gist\.githubusercontent\.com)/)) {
                 alert('请输入有效的 GitHub 链接');
                 return;
            }
            const finalUrl = baseUrl + url;
            
            // 显示结果
            document.getElementById('resultGroup').style.display = 'flex';
            document.getElementById('resultInput').value = finalUrl;
            
            // 尝试直接打开
            window.open(finalUrl, '_blank');
        }
        
        function copyResult() {
            var copyText = document.getElementById("resultInput");
            copyText.select();
            copyText.setSelectionRange(0, 99999);
            document.execCommand("copy");
            alert("已复制到剪贴板");
        }
    </script>
</body>
</html>
`;
// 前缀，如果自定义路由为example.com/gh/*，将PREFIX改为 '/gh/'，注意，少一个杠都会错！
const PREFIX = '/'
// 分支文件使用jsDelivr镜像的开关，0为关闭，默认关闭
const Config = {
    jsdelivr: 0
}

const whiteList = [] // 白名单，路径里面有包含字符的才会通过，e.g. ['/username/']

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
    status: 204,
    headers: new Headers({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,TRACE,DELETE,HEAD,OPTIONS',
        'access-control-max-age': '1728000',
    }),
}


const exp1 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:releases|archive)\/.*$/i
const exp2 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:blob|raw)\/.*$/i
const exp3 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/(?:info|git-).*$/i
const exp4 = /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+?\/.+$/i
const exp5 = /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/.+?\/.+?\/.+$/i
const exp6 = /^(?:https?:\/\/)?github\.com\/.+?\/.+?\/tags.*$/i

/**
 * @param {any} body
 * @param {number} status
 * @param {Object<string, string>} headers
 */
function makeRes(body, status = 200, headers = {}) {
    headers['access-control-allow-origin'] = '*'
    return new Response(body, { status, headers })
}


/**
 * @param {string} urlStr
 */
function newUrl(urlStr) {
    try {
        return new URL(urlStr)
    } catch (err) {
        return null
    }
}


addEventListener('fetch', e => {
    const ret = fetchHandler(e)
        .catch(err => makeRes('cfworker error:\n' + err.stack, 502))
    e.respondWith(ret)
})


function checkUrl(u) {
    for (let i of [exp1, exp2, exp3, exp4, exp5, exp6]) {
        if (u.search(i) === 0) {
            return true
        }
    }
    return false
}

/**
 * @param {FetchEvent} e
 */
async function fetchHandler(e) {
    const req = e.request
    const urlStr = req.url
    const urlObj = new URL(urlStr)
    let path = urlObj.searchParams.get('q')
    if (path) {
        return Response.redirect('https://' + urlObj.host + PREFIX + path, 301)
    }
    // cfworker 会把路径中的 `//` 合并成 `/`
    path = urlObj.href.slice(urlObj.origin.length + PREFIX.length).replace(/^https?:\/+/, 'https://')
    if (path.search(exp1) === 0 || path.search(exp5) === 0 || path.search(exp6) === 0 || path.search(exp3) === 0) {
        return httpHandler(req, path)
    } else if (path.search(exp2) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace('/blob/', '@').replace(/^(?:https?:\/\/)?github\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        } else {
            path = path.replace('/blob/', '/raw/')
            return httpHandler(req, path)
        }
    } else if (path.search(exp4) === 0) {
        if (Config.jsdelivr) {
            const newUrl = path.replace(/(?<=com\/.+?\/.+?)\/(.+?\/)/, '@$1').replace(/^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com/, 'https://cdn.jsdelivr.net/gh')
            return Response.redirect(newUrl, 302)
        }
        else {
            return httpHandler(req, path)
        }
    } else {
        if (path === '' || path === '/') {
            return new Response(HOME_PAGE, {
                status: 200,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            })
        }
        if (!ASSET_URL) {
            return new Response('Not Found', { status: 404 })
        }
        return fetch(ASSET_URL + path)
    }
}


/**
 * @param {Request} req
 * @param {string} pathname
 */
function httpHandler(req, pathname) {
    const reqHdrRaw = req.headers

    // preflight
    if (req.method === 'OPTIONS' &&
        reqHdrRaw.has('access-control-request-headers')
    ) {
        return new Response(null, PREFLIGHT_INIT)
    }

    const reqHdrNew = new Headers(reqHdrRaw)

    let urlStr = pathname
    let flag = !Boolean(whiteList.length)
    for (let i of whiteList) {
        if (urlStr.includes(i)) {
            flag = true
            break
        }
    }
    if (!flag) {
        return new Response("blocked", { status: 403 })
    }
    if (urlStr.search(/^https?:\/\//) !== 0) {
        urlStr = 'https://' + urlStr
    }
    const urlObj = newUrl(urlStr)

    /** @type {RequestInit} */
    const reqInit = {
        method: req.method,
        headers: reqHdrNew,
        redirect: 'manual',
        body: req.body
    }
    return proxy(urlObj, reqInit)
}


/**
 *
 * @param {URL} urlObj
 * @param {RequestInit} reqInit
 */
async function proxy(urlObj, reqInit) {
    const res = await fetch(urlObj.href, reqInit)
    const resHdrOld = res.headers
    const resHdrNew = new Headers(resHdrOld)

    const status = res.status

    if (resHdrNew.has('location')) {
        let _location = resHdrNew.get('location')
        if (checkUrl(_location))
            resHdrNew.set('location', PREFIX + _location)
        else {
            reqInit.redirect = 'follow'
            return proxy(newUrl(_location), reqInit)
        }
    }
    resHdrNew.set('access-control-expose-headers', '*')
    resHdrNew.set('access-control-allow-origin', '*')

    resHdrNew.delete('content-security-policy')
    resHdrNew.delete('content-security-policy-report-only')
    resHdrNew.delete('clear-site-data')

    return new Response(res.body, {
        status,
        headers: resHdrNew,
    })
}
