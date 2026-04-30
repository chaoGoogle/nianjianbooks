# PDF Server - Node.js 后端

基于 Express + pdfjs-dist 的 PDF 读取和分页查询服务。

## 快速开始

### 1. 启动服务

```bash
cd server
npm run dev
```

服务运行在：`http://localhost:8088`

### 2. API 接口

#### 获取书籍列表
```
GET /api/books
```

**响应:**
```json
{
  "success": true,
  "data": [
    {
      "file": "example.pdf",
      "title": "示例书籍",
      "author": "作者名"
    }
  ]
}
```

---

#### 获取 PDF 总页数
```
GET /api/file/pages?file=example.pdf
```

**参数:**
- `file`: PDF 文件名 (仅文件名，不支持路径)

**响应:**
```json
{
  "success": true,
  "data": {
    "totalPages": 120,
    "sourcePages": 120,
    "type": "pdf",
    "renderMode": "page"
  }
}
```

---

#### 提取 PDF 文本内容 (分页)
```
GET /api/file/extract?file=example.pdf&page=1&pageSize=10
```

**参数:**
- `file`: PDF 文件名
- `page`: 起始页码 (默认：1)
- `pageSize`: 每页条数 (默认：10, 最大：100)

**响应:**
```json
{
  "success": true,
  "data": {
    "pages": [
      {
        "pageNum": 1,
        "text": "第 1 页的文本内容..."
      }
    ],
    "type": "pdf"
  }
}
```

---

#### 生成 PDF 页面图片
```
GET /api/file/page-image?file=example.pdf&page=1&width=1600
```

**参数:**
- `file`: PDF 文件名
- `page`: 页码
- `width`: 图片宽度 (280-2400, 默认：1600)

**响应:** WebP 格式图片

---

#### 预处理 PDF 页面缓存
```
GET /api/process?pdfPath=example.pdf
```

**参数:**
- `pdfPath`: PDF 文件名

**响应:**
```json
{
  "success": true,
  "data": {
    "urls": ["/api/pdf-pages/..."],
    "sourcePages": 120,
    "pageCount": 120,
    "version": "abc123def456"
  }
}
```

---

## 项目结构

```
server/
├── server.js          # 主服务文件
├── modules/           # 模块目录
│   ├── pdf.js        # PDF 处理模块
│   ├── books.js      # 书籍扫描模块
│   ├── utils.js      # 工具函数
│   └── constants.js  # 常量配置
├── public/           # 静态资源目录
│   ├── books/       # PDF 书籍存放目录
│   └── cache/       # 缓存目录
├── package.json     # 依赖配置
└── README.md        # 说明文档
```

## 环境变量配置

可通过 `.env` 文件或环境变量配置以下参数：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | 8088 | 服务端口 |
| `WARMUP_ENABLED` | true | 是否启用启动预热 |
| `WARMUP_BOOK_COUNT` | 10 | 预热书籍数量 |
| `WARMUP_PAGE_COUNT` | 3 | 每本书预热页数 |
| `MAX_PDF_DOCUMENT_CACHE_SIZE` | 10 | PDF 文档缓存大小 |
| `MAX_PDF_PAGE_BUFFER_CACHE_SIZE` | 50 | PDF 页面缓冲缓存大小 |
| `MAX_PDF_IMAGE_CACHE_SIZE` | 100 | PDF 图片缓存大小 |

## 前端调用示例

```javascript
// 使用 axios 调用
import axios from 'axios';

const API_BASE = 'http://localhost:8088';

// 获取书籍列表
const books = await axios.get(`${API_BASE}/api/books`);

// 获取 PDF 页数
const pages = await axios.get(`${API_BASE}/api/file/pages?file=example.pdf`);

// 提取文本
const text = await axios.get(
  `${API_BASE}/api/file/extract?file=example.pdf&page=1&pageSize=10`
);
```

## 注意事项

1. PDF 文件需要放在 `public/books/` 目录下
2. 文件参数仅支持文件名，不支持路径（安全限制）
3. 服务已启用 CORS，允许所有来源访问
4. 生产环境建议设置 `NODE_ENV=production` 以隐藏详细错误信息

## 安全特性

- ✅ 路径遍历防护：严格限制文件访问范围
- ✅ CORS 配置：允许所有来源跨域访问
- ✅ 错误信息保护：生产环境隐藏敏感错误详情
- ✅ 输入验证：严格的文件扩展名和参数验证
- ✅ UTF-8 编码：统一使用 UTF-8 编码处理中文

## 性能优化

- ✅ LRU 缓存限容：防止内存泄漏
- ✅ 启动预热策略：可配置的预热范围
- ✅ 并发控制：合理的并发度配置
- ✅ Brotli 压缩：自动压缩静态资源
