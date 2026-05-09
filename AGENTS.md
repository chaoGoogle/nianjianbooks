# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-06
**Commit:** 87ee0c9 简易的翻阅书架

## OVERVIEW

Dual-repo monorepo: **Vue 3 + Vite SPA** (bookshelf-reader/) + **Express 5 backend** (server/). Book shelf display with page-flip reading, PDF content extraction API.

## STRUCTURE

```
book-libary/
├── .gitignore
├── bookshelf-reader/          # Vue 3 SPA (port 80): flipbook reader
│   ├── src/
│   │   ├── main.js           # App bootstrap
│   │   ├── App.vue           # Scene state machine (desk ↔ reader)
│   │   ├── components/      # ReaderScene, BookFlipbook
│   │   ├── composables/     # useBookReader (refactored into modules/)
│   │   └── styles/          # 9 CSS files (desk, flipbook, reader, etc.)
│   ├── public/vendor/js/     # turn.js, jquery (global scripts)
│   ├── index.html           # Loads jQuery + turn.js via script
│   └── vite.config.js       # Port 80, @/turnbook-js aliases, /api proxy
└── server/                   # Express API (port 8088): PDF extraction
    ├── server.js            # Single-file (484 lines): all routes
    └── modules/             # 4 modules: constants, pdf, books, utils
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new UI scene | bookshelf-reader/src/App.vue | Scene state machine with timing constants |
| Modify book reader | bookshelf-reader/src/components/ReaderScene.vue | Top bar + flipbook + video panel |
| Change flipbook behavior | bookshelf-reader/src/components/BookFlipbook.vue | turn.js integration, page rendering |
| Refactor composables | bookshelf-reader/src/composables/modules/ | 11 sub-modules (bookApi, pagination, rendering, etc.) |
| Add API route | server/server.js | Routes start at ~line 362 |
| PDF parsing | server/modules/pdf.js | pdfjs-dist with disabled worker |
| Book scanning | server/modules/books.js | Auto-discovers PDF files, extracts metadata |

## CONVENTIONS

- **Single-file server**: All API routes in server.js (484 lines), modules separated for clarity
- **jQuery global**: Loaded via script tags in index.html, NOT npm import
- **Vue provide/inject**: Shared state via `readerState` from useBookReader
- **Chinese error messages**: API responses in Chinese (`'扫描书籍目录失败'`, etc.)
- **Scene timing constants**: App.vue defines OPEN/CLOSE animation delays (ms)
- **No TypeScript**: Both repos use vanilla JS
- **Server port**: 8088 (defined in server/modules/constants.js)

## ANTI-PATTERNS

- **DO NOT** import jQuery/turn.js via ES modules
- **DO NOT** remove port 80 from vite.config.js
- **DO NOT** remove `disableWorker: true` from PDF loading
- **NEVER** manipulate DOM outside useBookReader.js (jQuery centralized)

## COMMANDS

```bash
# Frontend
cd bookshelf-reader && npm run dev    # Dev server port 80
cd bookshelf-reader && npm run build

# Backend
cd server && npm run dev             # Watch mode
cd server && npm run start            # Production
```

## NOTES

- No .eslintrc or .prettierrc config (defaults used)
- No test framework detected
- Server has no .env file (hardcoded paths)
- bookshelf-reader uses vite 8.x + Vue 3.5.x
- server uses express 5.x + pdfjs-dist 5.x
- Only PDF format supported (no EPUB)