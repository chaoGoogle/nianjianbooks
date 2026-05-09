# Book Library - 书架阅读器

翻书式 PDF 阅读器，Vue 3 前端 + Express 后端。

## 项目结构

```
book-libary/
├── bookshelf-reader/       # Vue 3 前端 (端口 80)
│   ├── src/
│   │   ├── App.vue         # 场景状态机 (书架 ↔ 阅读器)
│   │   ├── components/     # ReaderScene, BookFlipbook
│   │   ├── composables/    # useBookReader.js + modules/ (11 子模块)
│   │   └── styles/         # 9 个 CSS 文件
│   ├── public/vendor/js/   # turn.js, jQuery (全局脚本)
│   └── index.html
├── server/                 # Express 后端 (端口 8088)
│   ├── server.js           # 主服务文件 (484 行)
│   └── modules/            # 功能模块
│       ├── constants.js    # 常量配置
│       ├── pdf.js          # PDF 解析
│       ├── books.js        # 书籍扫描
│       └── utils.js        # 工具函数
├── .gitignore
└── README.md
```

## 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | >= 18.x |
| npm | >= 9.x |

## 快速开始

### 1. 安装依赖

```bash
# 前端
cd bookshelf-reader
npm install

# 后端
cd ../server
npm install
```

### 2. 配置环境变量

**前端** (`bookshelf-reader/.env.development`):
```env
VITE_API_BASE=http://localhost:8088
```

**后端** (`server/`): 无需额外配置，默认端口 8088。

### 3. 启动服务

```bash
# 终端 1 - 启动后端
cd server
npm run dev

# 终端 2 - 启动前端
cd bookshelf-reader
npm run dev
```

前端: `http://localhost:80`
后端: `http://localhost:8088`

### 4. 添加书籍

将 PDF 文件放入 `server/public/books/` 目录。

## 常用命令

```bash
# 前端开发
cd bookshelf-reader
npm run dev          # 开发服务器 (端口 80)
npm run build        # 生产构建

# 后端
cd server
npm run dev          # 热重载模式
npm run start        # 生产模式
```

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/books` | GET | 获取书籍列表 |
| `/api/file/pages?file=xxx.pdf` | GET | 获取书籍元数据 |
| `/api/file/extract?file=xxx.pdf&page=1` | GET | 提取页面内容 |
| `/api/file/page-image?file=xxx.pdf&page=1` | GET | 生成页面图片 |

## 技术栈

**前端:**
- Vue 3.5 + Vite 8
- jQuery (全局) + turn.js (翻书效果)
- axios (HTTP 请求)

**后端:**
- Express 5
- pdfjs-dist (PDF 解析)
- @napi-rs/canvas (封面渲染)

## 注意事项

- jQuery 通过 `<script>` 标签加载，**不要**用 ES module 导入
- 后端端口在 `server/modules/constants.js` 中配置 (默认 8088)
- 前端代理配置在 `bookshelf-reader/vite.config.js`
- 书籍文件仅支持 PDF 格式
