# gh-proxy (Cloudflare Worker 优化版)

这是 [gh-proxy]的深度重构和优化版本，旨在提供更稳定、更隐私且易于部署的 GitHub 加速服务。完美支持 **Cloudflare Workers** 和 **Cloudflare Pages**。

## ✨ 主要特性

- **完全独立**: 内置轻量级 HTML 首页，不依赖任何外部资源。
- **隐私增强**: 自动移除 Cookie、Referer、Origin 等敏感头，保护用户隐私。
- **全能加速**: 支持 `git clone`、Raw 文件、Release 附件、Gist 以及 GitHub API 加速。
- **智能修正**: 自动修正 `PREFIX` 配置错误、Referer 资源引用错误及 302 跳转。
- **API 支持**: 支持加速 GitHub API 请求 (如 `https://api.github.com/...`)，并可通过 `GH_TOKEN` 解决限流问题。
- **兼容性强**: 优化 Git 协议处理，解决 `RPC failed` 等兼容性问题。

---

## 🚀 部署指南

### 方法 1：Cloudflare Workers (最简单，适合手动)

如果你不需要 Git 版本控制，这是最快的方法：

1. 打开项目根目录下的 [index.js](index.js) 文件。
2. **全选并复制**所有代码。
3. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages**。
4. 点击 **Create Application** -> **Create Worker**。
5. 在在线编辑器中，**覆盖**原有代码，粘贴你刚才复制的代码。
6. 点击 **Deploy**。

### 方法 2：Cloudflare Pages (推荐，自动更新)

如果你希望通过 Git 管理代码并自动部署：

1. **Fork** 本仓库到你的 GitHub 账号。
2. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages**。
3. 点击 **Create Application** -> **Pages** -> **Connect to Git**。
4. 选择你 Fork 的仓库。
5. 在 **Build settings (构建设置)** 中填写：
   - **Framework preset**: `None`
   - **Build command (构建命令)**: `npm run build`
   - **Build output directory (构建输出目录)**: `dist`
6. 点击 **Save and Deploy**。

> **提示**: `index.js` 是为了方便手动复制而维护的纯 JS 版本，内容与 `src/index.ts` 编译后的 `dist/_worker.js` 逻辑一致。

---

## ⚙️ 环境变量配置

你可以在 Cloudflare 的设置页面 (Settings -> Environment variables) 添加以下变量：

| 变量名 | 说明 | 默认值 | 示例 |
| :--- | :--- | :--- | :--- |
| `ASSET_URL` | 首页重定向地址。**默认为空**，直接显示内置的极简 HTML 页面。如果设置了网址，访问根目录时会跳到该网址。 | (空) | `https://example.com` |
| `PREFIX` | 路径前缀。如果你的 Worker 部署在子路径下，请设置此项。程序会自动处理斜杠。 | `/` | `/gh/` |
| `WHITE_LIST` | 访问白名单。如果设置，只有包含这些关键词的路径才允许访问。多个关键词用英文逗号 `,` 分隔。 | (空) | `username,repo-name` |
| `GH_TOKEN` | GitHub Personal Access Token。用于解决 API 请求限流问题 (`API rate limit exceeded`)。建议使用无权限的 Token。 | (空) | `ghp_xxxx` |
| `JSDELIVR` | 文件加速切换。设置为 `1` 时，Raw 文件下载将尝试重定向到 jsDelivr。 | `0` | `1` |

---

## ❓ 常见问题 (FAQ)

**Q: 访问 API 时提示 `API rate limit exceeded`？**
A: 这是因为 GitHub 对未授权请求的 IP 限流。
   - **解决**: 申请一个无权限的 [GitHub Personal Access Token](https://github.com/settings/tokens)，然后在 Cloudflare 环境变量中添加 `GH_TOKEN`，值为你的 Token。

**Q: `git clone` 时报错 `RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly`？**
A: 这是由于 HTTP/2 协议兼容性问题导致的。本版本已针对此问题进行了优化（移除 `Content-Encoding` 等干扰头），请确保使用最新版本的代码。

**Q: 使用 PREFIX (如 `/gh/`) 浏览 GitHub 页面时，为何有时会报错或一直加载？**
A: 这是一个已知限制。建议将 Worker 部署在根目录（`PREFIX` 设为 `/`）以获得最佳体验。
