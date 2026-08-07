# PDF Server - Bun 后端

基于 Bun.serve + pdfjs-dist 的 PDF 读取、渲染与缓存服务。无 Express，运行时仅需 Bun (>= 1.3)。

## 快速开始

```bash
bun install
bun run dev      # --watch 热重载
bun run start    # 生产
```

服务运行在 `http://localhost:8088`。PDF 文件放入 `public/books/`。

## API 接口

```
GET /api/health                            健康检查（缓存/worker/内存状态）
GET /api/books                             书籍列表（?refresh=1 强制重扫）
GET /api/books/by-name/:name               按书名查单本
GET /api/file/pages?file=xxx.pdf           PDF 页数
GET /api/file/page-image?file=xxx.pdf&page=1&width=2400   单页 webp 实时渲染
GET /api/process?pdfPath=xxx.pdf           全页缓存 URL 列表 + 后台渲染
GET /api/pdf-pages/<base>/<version>/page-N.webp   缓存页（404 自动单页重渲染）
GET /api/book-thumbs/<file>                封面缩略图
```

## 架构

- `server.js` — Bun.serve 路由、书籍缓存、预热、单页重试、内存看门狗
- `modules/pdf.js` — pdfjs 解析/渲染（主线程，含 LRU 缓存）
- `modules/renderPool.js` + `renderWorker.js` — Worker 线程池并行渲染
- `modules/books.js` — 目录扫描与元数据

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `WARMUP_ENABLED` | `true` | 启动自动预热 |
| `RENDER_POOL_SIZE` | `min(CPU-1, 4)` | 渲染线程数 |
| `MEMORY_RSS_LIMIT_MB` | `3072` | RSS 上限 |

详细项目文档见仓库根目录 `README.md`。
