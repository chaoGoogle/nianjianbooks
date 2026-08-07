# 后端迁移至 Bun 原生服务（Bun.serve）设计

日期：2026-08-07
状态：已获用户批准（2026-08-07）

## 目标

将 `server/` 从 Express 5 完全迁移至 Bun 原生 `Bun.serve`，删除 `express` 与 `cors` 依赖，利用 Bun 特性（声明式 `routes`、`Bun.file()` 零拷贝静态文件、`Bun.gc()`）优化实现。运行时由 Node.js 切换为 Bun（本机 bun 1.3.14 已确认可用）。

## 范围

- **只改**：`server/server.js`、`server/package.json`
- **不改**：`server/modules/`（constants.js、pdf.js、books.js、utils.js）业务逻辑原样保留
- **不改**：API 行为、URL、响应结构、缓存/warmup 逻辑、brotli sidecar 机制
- 前端 `bookshelf-reader/` 不动（vite 代理目标端口不变，仍为 8088）

## 架构

### server.js 结构

```js
Bun.serve({
  port: PORT,              // 8088，来自 modules/constants.js
  routes: { ... },         // 6 个 API 路由（声明式）
  fetch(req) { ... },      // 兜底：CORS/OPTIONS、静态文件、.br 旁挂
});
```

### 路由表（routes 对象）

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 + 内存状态 |
| `/api/books` | GET | 书籍列表（支持 `?refresh=1`） |
| `/api/books/by-name/:name` | GET | 按名查书（Bun routes 原生 `:param` 解析） |
| `/api/file/pages` | GET | PDF 页数 |
| `/api/file/page-image` | GET | 单页 webp 渲染（含 ETag） |
| `/api/process` | GET | 全页 URL 列表 + 后台渲染 |

所有 handler 为 async 函数，返回 `Response.json(...)`；错误统一 `Response.json({ success:false, message, error }, { status })`，中文错误消息不变。

### fetch 兜底（静态文件 + CORS）

处理顺序：

1. 统一日志一行（`[ISO时间] METHOD 路径`）
2. `OPTIONS` → 204 + CORS 头
3. `/api/book-thumbs/*` → `Bun.file()` 返回，`Cache-Control: public, max-age=31536000, immutable`
4. `/api/pdf-pages/*` → 路径规范化 + 穿越防护（resolve 后必须在 PDF_PAGE_CACHE_DIR 内）；若 `Accept-Encoding` 含 `br` 且存在 `<file>.br`，返回 `Bun.file(compressedPath)` + `Content-Encoding: br` + `Content-Type: image/webp`；否则返回原始文件。均带 immutable 缓存头 + `Vary: Accept-Encoding`
5. 其余路径 → `public/` 静态目录（`path.join(__dirname, '../public')`），同样做穿越防护；404 返回 "Not Found"

所有静态响应统一附加 CORS 头（`Access-Control-Allow-Origin: *` 等）。

### CORS 与日志

- 删除 `cors` 包与手写 CORS 中间件，改为 helper 函数给 Response 添加 CORS 头
- `express.json()` 删除（所有路由均为 GET，无 body 解析需求）

### 其他替换点

| Express/Node 写法 | Bun 替换 |
|---|---|
| `createReadStream(...).pipe(res)` | `Bun.file(path)`（流式、自动 Range） |
| `res.json(obj)` / `res.status(n).json(obj)` | `Response.json(obj, { status })` |
| `res.setHeader(k, v)` + `res.send(buf)` | `new Response(buf, { headers })` |
| `req.query.x` | `new URL(req.url).searchParams.get('x')` |
| `req.params.name` | routes handler 第二参 `req.params.name`（Bun 原生） |
| `global.gc()` | `Bun.gc(true)` |
| `app.listen(PORT)` | `Bun.serve({ port: PORT })` |

内存监控（setInterval checkMemory）、warmup、后台渲染任务、并发控制等业务代码原样保留，仅替换 GC 调用。

### package.json

- 删除依赖：`express`、`cors`
- 保留依赖：`@napi-rs/canvas`、`pdfjs-dist`（需在 bun 下实测兼容）
- scripts 改为：
  - `"dev": "bun --watch server.js"`
  - `"start": "bun server.js"`
- 删除 `package-lock.json`（npm 锁文件），保留 `bun.lock`

## 错误处理

- `process.on('uncaughtException'/'unhandledRejection')` 保留
- 路由内 try/catch 逻辑不变，仅把 `res.status().json()` 换成 `Response.json()`
- 静态文件不存在 → 404；路径穿越 → 400

## 验证方案

1. `bun server.js` 启动成功，监听 8088
2. pdfjs-dist、`@napi-rs/canvas` 在 bun 下正常加载（无 worker 报错）
3. curl 验证全部端点：
   - `GET /api/health` → 200 JSON
   - `GET /api/books` → 200，书籍列表
   - `GET /api/books/by-name/:name` → 200/404
   - `GET /api/file/pages?file=xxx.pdf` → 页数
   - `GET /api/file/page-image?file=xxx.pdf&page=1` → webp 图片 + ETag
   - `GET /api/process?pdfPath=xxx.pdf` → urls 数组
   - `GET /api/pdf-pages/...` 带 `Accept-Encoding: br` → `Content-Encoding: br`
   - `GET /api/book-thumbs/...` → 缩略图
   - `OPTIONS /api/books` → 204 + CORS 头
   - 路径穿越请求（`..`）→ 400
4. 前端 dev 代理（vite :5473 → :8088）联调翻书流程

## 非目标（YAGNI）

- 不引入 Bun.serve 的 WebSocket、TLS、开发模式 HMR
- 不重构 modules/ 内部实现
- 不做性能基准对比报告
