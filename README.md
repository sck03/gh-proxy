# gh-proxy

基于 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy) 改进的 GitHub 文件代理，可部署到 Cloudflare Workers 或 Pages。支持 Git clone/fetch、Raw 文件、Release 附件、源码压缩包、Gist 和 GitHub API。

## 使用

在 GitHub 地址前加上你的服务地址：

```text
https://你的域名/https://github.com/owner/repo/releases/download/v1.0/file.zip
https://你的域名/https://github.com/owner/repo/blob/main/README.md
https://你的域名/https://api.github.com/repos/owner/repo
```

```sh
git clone https://你的域名/https://github.com/owner/repo.git
```

也支持省略目标协议，以及将整个目标 URL 编码一次的链接。普通链接中的路径编码、查询参数和下载签名保持原样。`blob` 文件地址和 Gist 文件页面会转换为 Raw 地址；GitHub 完整网页的脚本、登录和相对链接不保证兼容。

## 部署

### Cloudflare Workers：手动复制

1. 在 Cloudflare Dashboard 的 **Workers & Pages** 中创建 Worker。
2. 将仓库根目录 [index.js](index.js) 的全部内容粘贴到编辑器并部署。
3. 将运行时兼容日期设为 `2026-10-12` 或更晚；更新已有 Worker 时也需要检查此项。
4. 在设置中添加需要的环境变量；`GH_TOKEN` 应保存为 Secret。

### Cloudflare Pages：Git 自动构建

连接本仓库或你的 Fork，选择以下构建设置：

| 设置 | 值 |
| --- | --- |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js | `24`（环境变量 `NODE_VERSION=24`） |

构建生成 Pages 高级模式入口 `dist/_worker.js`。在 Pages 项目设置中配置运行时变量和 Secret，并将兼容日期设为 `2026-10-12` 或更晚。修改运行时配置后重新部署。

### 本地开发与 Workers CLI

需要 Node.js 22 或更高版本，推荐 Node.js 24。

```sh
npm ci
npm run dev
npm run check
npm run deploy
```

本地密钥可放在 `.dev.vars` 中，该文件不会提交。生产 Token 使用 `npx wrangler secret put GH_TOKEN` 配置。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PREFIX` | `/` | 代理路径前缀，例如 `/gh/`。自动去掉首尾空格并补齐斜杠。使用时在此前缀后拼接完整目标 URL。 |
| `ASSET_URL` | 空 | 仅用于首页的 HTTP/HTTPS 重定向；为空或无效时显示内置 Welcome 页面。不会用作其他地址的代理回退。 |
| `WHITE_LIST` | 空 | 按目标主机名或解码后的路径进行关键词匹配，用英文逗号分隔，例如 `/owner/repo/,/another/repo/`。忽略空白项；查询参数不参与匹配。 |
| `GH_TOKEN` | 空 | 仅在初始目标为 `api.github.com` 的 GET/HEAD 请求中补充鉴权；客户端已经携带 Authorization 时保留客户端值。 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 从首次请求到最终响应头的总等待时间，包含上传和重定向；有效范围 1000–120000 毫秒，越界值限制到边界，无效值使用默认值。响应体下载不受此期限限制。 |

`WHITE_LIST` 是关键词过滤，并非严格的仓库权限系统。例如允许 `/owner/repo/` 也可能匹配其他路径中相同的片段。读取请求经过过滤后可继续跟随受信任 GitHub 下载域名的跳转，因此 Release 的签名附件地址无需额外列入关键词。全部为空白的配置等同于未启用过滤。

`GH_TOKEN` 供服务访问者共享，只应使用无私有仓库权限、无写权限的 Token。服务端 Token 不会自动用于 POST/PUT/PATCH/DELETE，也不会注入 Raw、Git、Release 或 S3 下载。需要写入或私有仓库操作的调用者应自行提供 Authorization。跨域跳转会移除已有鉴权；带鉴权的响应禁止共享缓存。

## 传输与错误处理

- 请求体和响应体直接流式传输，不整包读取或复制大文件；保留 `Content-Encoding`、`Content-Length`、Range、ETag 和上游缓存语义，避免不必要的解压、重压缩。
- GET/HEAD 在 Worker 内跟随最多 5 次受信任跳转，并取消丢弃的响应体；每一跳都校验 HTTPS、端口和完整域名。拒绝 URL 内嵌用户名或密码。
- 带请求体的方法保留上游 301/302/303/307/308 状态，将 Location 改写为代理路径，由客户端处理重定向和请求体重发。
- 清理 Cookie、Referer、客户端转发 IP、逐跳请求头，以及上游 Set-Cookie；所有本地错误都带 CORS 响应头。错误正文不回显请求 URL、签名或 Token。
- 白名单拒绝返回 `403`，无效目标返回 `400`，前缀不匹配返回 `404`，上游连接或跳转失败返回 `502`，等待响应头超时返回 `504`。

支持的完整主机名集中在 [src/index.ts](src/index.ts) 的 `ALLOWED_HOSTS` 中，包含 `release-assets.githubusercontent.com` 和旧版 GitHub Release S3 主机。不会任意跟随外部域名，也不会强制缓存私有响应。

## 维护与验证

[src/index.ts](src/index.ts) 是唯一维护的源码；`npm run build` 自动生成内容相同的根目录 `index.js` 和 `dist/_worker.js`。修改源码后提交生成的 `index.js`，不要手工维护第二份实现。历史实现可通过 Git 历史查看。

`npm run check` 执行严格类型检查、构建和自动化测试，覆盖 URL、白名单、Token、Git 请求体、重定向、压缩、断点续传、超时和取消。测试中的上游均为本地模拟，不需要 GitHub 或 Cloudflare 凭据。CI 还检查生成文件是否同步，并执行 Wrangler 部署预检。

```sh
npm run check
npx wrangler deploy --dry-run --outdir dist/wrangler
```
