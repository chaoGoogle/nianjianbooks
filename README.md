# Book Library - 书架阅读器

翻书式 PDF 阅读器。Vue 3 前端 + Bun 原生后端，支持书架展示、翻页动画阅读、PDF 页面预渲染缓存。

**运行时为 Bun (>= 1.3)，不使用 Node.js / npm。**

## 功能特性

- 书架场景 ↔ 阅读场景切换，turn.js 翻书动画
- PDF 全页预渲染为 webp，brotli 预压缩，immutable 缓存
- 后端多 Worker 线程并行渲染（预热提速约 3 倍）
- 缓存页 404 自动单页重渲染（按需重试，带并发去重）
- 内存看门狗：超限自动清缓存 + 广播 purge 渲染 Worker + GC
- 启动自动预热书库与页面缓存（可关）

## 项目结构

```
book-libary/
├── bookshelf-reader/          # Vue 3 前端（dev 端口 5473）
│   ├── src/
│   │   ├── App.vue            # 场景状态机（书架 ↔ 阅读器）
│   │   ├── components/        # ReaderScene, BookFlipbook
│   │   ├── composables/       # useBookReader + modules/
│   │   └── styles/            # CSS
│   ├── scripts/precompress.mjs  # 构建后 brotli 预压缩 dist
│   └── public/vendor/js/      # turn.js, jQuery（全局脚本，非 npm）
└── server/                    # Bun 后端（端口 8088）
    ├── server.js              # Bun.serve：路由 + 缓存 + 预热 + 重试
    └── modules/
        ├── constants.js       # 端口/目录常量
        ├── pdf.js             # pdfjs 解析与渲染（主线程 API 用）
        ├── books.js           # 书籍目录扫描
        ├── renderPool.js      # 渲染 Worker 池
        ├── renderWorker.js    # Worker 内 PDF 渲染
        └── utils.js           # 工具函数
```

## 环境要求

| 依赖 | 版本 |
|------|------|
| Bun | >= 1.3 |

## 快速开始

```bash
# 1. 安装依赖
cd bookshelf-reader && bun install
cd ../server && bun install

# 2. 添加书籍：把 PDF 放入 server/public/books/

# 3. 启动后端（终端 1）
cd server && bun run dev        # --watch 热重载；生产用 bun run start

# 4. 启动前端（终端 2）
cd bookshelf-reader && bun run dev
```

访问：`http://localhost:5473`（前端 dev 已配 `/nianjian/api` → 后端 `/api` 代理）

生产构建：

```bash
cd bookshelf-reader && bun run build   # vite build + 自动 brotli 预压缩 dist
```

## 配置

**前端** `bookshelf-reader/.env.development`（gitignored）：

```env
VITE_API_BASE=http://localhost:8088
```

**后端环境变量**（均可选）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `WARMUP_ENABLED` | `true` | 启动时自动预热书库+页面缓存，设 `false` 关闭 |
| `RENDER_POOL_SIZE` | `min(CPU-1, 4)` | 渲染 Worker 线程数（同时受空闲内存约束） |
| `MEMORY_RSS_LIMIT_MB` | `3072` | 进程 RSS 上限，超限清缓存+purge Worker+GC |
| `MAX_PDF_DOCUMENT_CACHE_SIZE` | `3` | 主线程 PDF 文档 LRU 缓存数 |
| `MAX_PDF_PAGE_BUFFER_CACHE_SIZE` | `5` | 页面 buffer LRU 缓存数 |
| `CACHE_TTL_MS` | `60000` | LRU 缓存过期时间 |

端口：后端 `8088`（`server/modules/constants.js`），前端 dev `5473`（`vite.config.js`）。

## API 接口

| 接口 | 说明 |
|------|------|
| `GET /api/health` | 健康检查：缓存/预热/worker/内存状态 |
| `GET /api/books` | 书籍列表（`?refresh=1` 强制重扫） |
| `GET /api/books/by-name/:name` | 按书名（不含 .pdf）查单本 |
| `GET /api/file/pages?file=xxx.pdf` | PDF 页数 |
| `GET /api/file/page-image?file=xxx.pdf&page=1&width=2400` | 单页 webp 实时渲染（带 ETag） |
| `GET /api/process?pdfPath=xxx.pdf` | 全页缓存 URL 列表 + 触发后台渲染 |
| `GET /api/pdf-pages/<base>/<version>/page-N.webp` | 缓存页直出（支持 br；404 自动单页重渲染） |
| `GET /api/book-thumbs/<file>` | 书籍封面缩略图 |

所有接口仅 GET，CORS 全开，错误消息为中文。

## 技术栈

**前端：** Vue 3.5 + Vite 8（`bun --bun` 运行）、jQuery（全局 script）+ turn.js、axios

**后端：** Bun.serve（无框架）、pdfjs-dist、@napi-rs/canvas、Bun Worker 线程池

## 性能设计

- 页面渲染走 Worker 池并行（PDF 文档句柄在 Worker 内缓存，逐页 `page.cleanup()`）
- 缓存页 brotli 旁挂在渲染循环后批量并行压缩
- 缓存 URL 带版本哈希（文件名+大小+mtime），文件变更自动失效
- Worker 池不可用时自动回退主线程渲染

## 注意事项

- jQuery/turn.js 通过 `<script>` 标签全局加载，**不要**用 ES module 导入
- pdfjs `getDocument` 必须保留 `disableWorker: true`
- 后端依赖仅 `@napi-rs/canvas` + `pdfjs-dist`，不要重新引入 express
- 书籍仅支持 PDF；文件名建议 `书名_作者.pdf` 或 `[作者]书名.pdf` 以自动解析元数据
