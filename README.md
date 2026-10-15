# gh-proxy

基于 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy) 改进的 GitHub/GitLab 文件代理，可部署到 Cloudflare Workers 或 Pages。支持 GitHub 公开仓库网页浏览、Git clone/fetch、Raw 文件、Release 附件、源码压缩包、Gist、GitHub/GitLab API，以及 `git.io` 短链解析。

## 最简单的用法：修改顶部配置，复制即可部署

1. 打开根目录 [index.js](index.js)，按需要修改顶部带中文注释的 **用户配置区**。
2. 将整个文件复制到新建或已有的 Cloudflare Worker 编辑器，保存并部署。

**无需安装 Node.js、运行构建或创建环境变量。普通使用也不需要 Token。** 默认已经设置为原来的 `/gh/` 路径。

配置集中在文件顶部，下面的代理逻辑通常不需要修改：

```js
const DEFAULTS = {
  PREFIX: '/gh/',               // 路径前缀；想使用根目录则改成 '/'
  ASSET_URL: '',                // 首页跳转地址；留空显示 Welcome 页面
  WHITE_LIST: '',               // 白名单；留空不限制 GitHub 路径
  GH_TOKEN: '',                 // 可选，只在需要提高 GitHub API 限额时填写
  UPSTREAM_TIMEOUT_MS: 30000,   // 等待响应头的超时，单位毫秒
};
```

已按原项目的 `2023-10-02` 兼容日期验证，也覆盖 `2026-10-12` 的兼容模式。**不再要求把已有 Worker 的日期改成 `2026-10-12`。**

## 使用地址：默认带 /gh/

保持 `PREFIX: '/gh/'` 时：

```text
https://你的域名/gh/https://github.com/owner/repo/releases/download/v1.0/file.zip
https://你的域名/gh/https://github.com/owner/repo/blob/main/README.md
https://你的域名/gh/https://api.github.com/repos/owner/repo
```

```sh
git clone https://你的域名/gh/https://github.com/owner/repo.git
```

如果把顶部配置改成 `PREFIX: '/'`，对应地址就是：

```text
https://你的域名/https://github.com/owner/repo/releases/download/v1.0/file.zip
```

也支持省略目标协议，以及将整个目标 URL 编码一次的链接。普通链接中的路径编码、查询参数和下载签名保持原样。`blob` 文件地址和 Gist 文件页面会转换为 Raw 地址。

### GitLab.com 和 git.io

不用增加配置，直接使用同一个代理前缀：

```text
https://你的域名/gh/https://git.io/短码
https://你的域名/gh/https://gitlab.com/group/project/-/raw/main/README.md
https://你的域名/gh/https://gitlab.com/group/subgroup/project/-/blob/main/README.md
https://你的域名/gh/https://gitlab.com/group/project/-/archive/main/project-main.tar.gz
https://你的域名/gh/https://gitlab.com/api/v4/projects/group%2Fproject
```

```sh
git clone https://你的域名/gh/https://gitlab.com/group/project.git
```

- GitLab 支持多级子组；`/-/blob/` 文件链接自动转换为 `/-/raw/`，分支、文件名和 API 项目路径的编码保持原样。
- `git.io` 自动解析仍有效的短链，再按目标处理下载。开启白名单时，检查解析后的仓库地址；短码和查询参数不能绕过过滤。
- `GH_TOKEN` 仍只用于 GitHub API，不会发送给 GitLab 或 `git.io`。GitLab 客户端可自行携带 `Authorization`、`Private-Token`、`Job-Token` 或 `Deploy-Token`；专用头仅发往 `gitlab.com`，跨域跳转时清除鉴权，鉴权响应不共享缓存。
- 这里支持的是 `gitlab.com` 的文件、Git 协议和 API；自建 GitLab 域名及外部附件站点不会自动放行。网页路径增强目前面向 GitHub 公开仓库。

2026-10-15 实测：GitLab Raw、文件页转换、API、Git 读取和 Range 下载通过。测试仓库的压缩包接口直连及代理均返回 `406 Not Acceptable`，尚未验证其成功下载；代理保留上游状态。

### 公开仓库网页

可以直接打开带代理前缀的仓库地址，例如：

```text
https://你的域名/gh/https://github.com/sck03/gh-proxy
```

网页会自动适配代理路径，让最新提交、各文件的提交说明与时间、分支数量等后续内容正常加载。目录切换、刷新、前进后退和新标签页打开均保留代理前缀；无需增加配置。

本功能面向公开内容的匿名浏览，GitHub 登录及需要账户权限的操作不受支持。网页功能可能随 GitHub 前端更新而变化；`blob` 链接仍保持原项目的 Raw 下载行为。

如果之前手动复制代码部署，更新时同样将新版 `index.js` 全部复制到 Worker 编辑器并部署即可，继续保留你自己的顶部配置。只更新 GitHub 仓库不会自动更新手动部署的 Worker；连接 Git 自动部署的 Pages 则等待构建完成。

## 可选：自动部署或本地开发

### Cloudflare Pages：Git 自动构建

连接本仓库或你的 Fork，选择以下构建设置：

| 设置 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js | `24`（环境变量 `NODE_VERSION=24`） |

直接修改仓库 `index.js` 顶部的配置并提交即可，构建会生成 Pages 高级模式入口 `dist/_worker.js`。环境变量也可用于覆盖代码配置，均为可选。更新已有 Pages 项目时，无需为本版强制改成新的兼容日期。

### 本地开发与 Workers CLI

需要 Node.js 22 或更高版本，推荐 Node.js 24。

```sh
npm ci
npm run dev
npm run check
npm run deploy
```

以上命令仅供使用 Git、Pages 或 CLI 的开发者使用；手动复制部署不需要执行。本地可选变量可放在 `.dev.vars` 中，该文件不会提交。

## 配置说明

优先级为：**已设置的 Cloudflare 同名环境变量 > `index.js` 顶部的 `DEFAULTS`**。如果只想在代码里修改，就不用创建任何环境变量。已有环境变量会继续生效，包括空字符串。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PREFIX` | `/gh/` | 代理路径前缀。设为 `/` 可使用根目录；也可改成其他子路径。自动去掉首尾空格并补齐斜杠。 |
| `ASSET_URL` | 空 | 仅用于首页的 HTTP/HTTPS 重定向；为空或无效时显示内置 Welcome 页面。不会用作其他地址的代理回退。 |
| `WHITE_LIST` | 空 | 按目标主机名或解码后的路径进行关键词匹配，用英文逗号分隔，例如 `/owner/repo/,/another/repo/`。忽略空白项；查询参数不参与匹配。 |
| `GH_TOKEN` | 空 | 仅在初始目标为 `api.github.com` 的 GET/HEAD 请求中补充鉴权；客户端已经携带 Authorization 时保留客户端值。 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 从首次请求到最终响应头的总等待时间，包含上传和重定向；有效范围 1000–120000 毫秒，越界值限制到边界，无效值使用默认值。响应体下载不受此期限限制。 |

`WHITE_LIST` 是关键词过滤，并非严格的仓库权限系统。例如允许 `/owner/repo/` 也可能匹配其他路径中相同的片段。读取请求经过过滤后可继续跟随受信任 GitHub 下载域名的跳转，因此 Release 的签名附件地址无需额外列入关键词。全部为空白的配置等同于未启用过滤。

`GH_TOKEN` 可以一直留空：文件下载、Release、Git clone 不需要它，GitHub API 也支持匿名请求。仅在 API 限流时考虑填写。可以直接在 Worker 编辑器的顶部配置区填写；若选择在 Cloudflare 设置中配置，建议保存为 Secret，也可通过 `npx wrangler secret put GH_TOKEN` 设置。**不要把真实 Token 提交到公开仓库。**

服务端 Token 供访问者共享，应使用无私有仓库权限、无写权限的 Token。它只自动用于 API 的 GET/HEAD 请求，不会注入 Raw、Git、Release 或 S3 下载。跨域跳转会移除已有鉴权；带鉴权的响应禁止共享缓存。

## 传输与错误处理

- 请求体和响应体直接流式传输，不整包读取或复制大文件；保留 `Content-Encoding`、`Content-Length`、Range、ETag 和上游缓存语义，避免不必要的解压、重压缩。
- 浏览器打开的 GitHub HTML 使用 `HTMLRewriter` 流式适配链接并加入页面路径脚本；为兼容旧运行时协商 gzip，清除改写后失效的大小、校验值和缓存。Raw、附件、API、Git、HEAD 和 Range 响应保持原样。
- GET/HEAD 在 Worker 内跟随最多 5 次受信任跳转，并取消丢弃的响应体；每一跳都校验 HTTPS、端口和完整域名。拒绝 URL 内嵌用户名或密码。
- 带请求体的方法保留上游 301/302/303/307/308 状态，将 Location 改写为代理路径，由客户端处理重定向和请求体重发。带鉴权的跨域上传跳转会被拒绝，避免客户端向同域代理重发鉴权时泄露给另一站点。
- 清理 Cookie、Referer、客户端转发 IP、逐跳请求头，以及上游 Set-Cookie；所有本地错误都带 CORS 响应头。错误正文不回显请求 URL、签名或 Token。
- 白名单拒绝返回 `403`，无效目标返回 `400`，前缀不匹配返回 `404`，上游连接或跳转失败返回 `502`，等待响应头超时返回 `504`。

支持的完整主机名集中在 [index.js](index.js) 的 `ALLOWED_HOSTS` 中，包含 `release-assets.githubusercontent.com` 和旧版 GitHub Release S3 主机。不会任意跟随外部域名，也不会强制缓存私有响应。

## 维护与验证

[index.js](index.js) 是唯一维护的源码，保留中文注释和可编辑的配置区。`npm run build` 只生成 `dist/_worker.js`，**不会覆盖或改写 `index.js`**。手动部署直接复制 `index.js`；Pages 自动部署使用构建产物。历史实现可通过 Git 历史查看。

`npm run check` 对 JavaScript 源码执行严格类型检查、构建和自动化测试，覆盖代码配置、可选环境变量、`/gh/` 和根路径、URL、白名单、Token、GitLab 子组与鉴权、`git.io` 解析、Git 请求体、重定向、压缩、HTML 改写、断点续传、超时和取消。`npm run test:browser` 另外验证页面初始化、异步内容、目录切换、刷新、前进后退、新标签页、表单和多级前缀。测试中的上游均为本地模拟，不需要 GitHub 或 Cloudflare 凭据。CI 分别验证新旧兼容日期，并执行 Wrangler 部署预检。

```sh
npm run check
npx playwright-core install chromium
npm run test:browser
npx wrangler deploy --dry-run --outdir dist/wrangler
```

浏览器测试也可以使用已安装的 Windows Edge/Chrome，或通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定可执行文件；这些开发工具不影响直接复制部署。
