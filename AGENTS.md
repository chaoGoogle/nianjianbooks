# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-20
**Commit:** 20b4660 修复

## OVERVIEW

Dual-repo monorepo: **Vue 3 + Vite SPA** (bookshelf-reader/) + **Express 5 backend** (server/). Book shelf display with page-flip reading, PDF/EPUB content extraction API.

## STRUCTURE

```
book/
├── .gitignore
├── bookshelf-reader/          # Vue 3 SPA (port 80): book grid, flipbook reader
│   ├── src/
│   │   ├── main.js           # App bootstrap
│   │   ├── App.vue           # Scene state machine (desk ↔ reader)
│   │   ├── components/      # DeskScene, ReaderScene, BookFlipbook
│   │   ├── composables/     # useBookReader (~900 lines, centralized state)
│   │   └── styles/          # 10 CSS files (dark, desk, flipbook, etc.)
│   ├── public/vendor/js/     # turn.js, jquery (global scripts)
│   ├── index.html           # Loads jQuery + turn.js via script
│   └── vite.config.js       # Port 80, @/turnbook-js aliases, /api proxy
└── server/                   # Express API (port 3000): PDF/EPUB extraction
    ├── server.js            # Single-file (~1200 lines): all routes
    └── modules/             # 6 modules: constants, pdf, epub, search, books, utils
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new UI scene | bookshelf-reader/src/App.vue | Scene state machine with timing constants |
| Modify book grid | bookshelf-reader/src/components/DeskScene.vue | Card animations |
| Change flipbook behavior | bookshelf-reader/src/composables/useBookReader.js | All jQuery/turn.js logic |
| Add API route | server/server.js | Routes start at ~line 724 |
| PDF parsing | server/modules/pdf.js | pdfjs-dist with disabled worker |
| EPUB parsing | server/modules/epub.js | JSZip-based extraction |

## CONVENTIONS

- **Single-file server**: All API routes in server.js (~344 lines), modules separated for clarity
- **jQuery global**: Loaded via script tags in index.html, NOT npm import
- **Vue provide/inject**: Shared state via `readerState` from useBookReader
- **Chinese error messages**: API responses in Chinese (`'扫描书籍目录失败'`, etc.)
- **Scene timing constants**: App.vue defines OPEN/CLOSE animation delays (ms)
- **No TypeScript**: Both repos use vanilla JS

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