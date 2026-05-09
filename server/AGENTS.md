# SERVER

Express API backend for PDF content extraction, cover rendering, and book scanning.

## STRUCTURE

```
server/
├── server.js    # Single-file Express server (484 lines): all routes + helpers
├── modules/
│   ├── constants.js  # Port, paths, validation helpers
│   ├── pdf.js        # PDF parsing (pdfjs-dist, disabled worker)
│   ├── books.js      # Book scanning, metadata extraction
│   └── utils.js      # Utility functions
├── package.json # Dependencies: express 5, pdfjs-dist, @napi-rs/canvas
└── README.md    # API documentation (Chinese)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a new API route | `server.js` — find the API routes section | Routes start at ~line 362 |
| Modify PDF parsing | `server.js` → `extractPdfText()`, `normalizePdfItems()` | pdfjs-dist with disabled worker; CJK-aware line splitting |
| Change cover rendering | `server.js` → `renderPdfCover()`, `buildPdfPlaceholderCover()` | @napi-rs/canvas renders page 1 as PNG; fallback generates SVG data URI |
| Add file type support | `ALLOWED_EXTENSIONS` array in `modules/constants.js` | Currently `.pdf` only |
| Book scanning | `modules/books.js` → `scanBooksProgressive()` | Auto-discovers PDF files; extracts metadata (title, author, cover) |

## CONVENTIONS

- **Single-file architecture** — all routes, helpers, and config in server.js
- **Chinese error messages** — API responses use Chinese (`'扫描书籍目录失败'`, `'文件不存在'`, etc.)
- **PDF worker disabled** — `disableWorker: true` + `GlobalWorkerOptions.workerSrc` set to file URL for Node.js environment
- **Input validation** — `validateInt()`, `validateFileExt()`, `sanitizeError()` helpers; file extension whitelist

## ANTI-PATTERNS (THIS PROJECT)

- **DO NOT** split server.js into multiple files without careful planning — the single-file pattern is intentional for this project's scale
- **NEVER** remove `disableWorker: true` from PDF loading — Node.js environment requires it
- **DO NOT** change BOOKS_DIR path logic — it uses `path.join(__dirname, '../public/books')` relative to server/
- **DO NOT** add file types to ALLOWED_EXTENSIONS without implementing a corresponding extraction handler

## NOTES

- PDF text normalization (`normalizePdfItems`) includes CJK character detection for proper spacing logic
- `server/images/` is gitignored — used as runtime cache but not persisted in repo
- Static file serving: `express.static(path.join(__dirname, '../public'))` serves the root public/ directory
- Book scanning (`scanBooksProgressive()`) auto-discovers PDF files; extracts metadata (title, author, cover) for each