# PROJECT KNOWLEDGE BASE

Dual-repo monorepo: **Vue 3 + Vite SPA** (bookshelf-reader/) + **Bun-native backend** (server/). Book shelf display with page-flip reading, PDF content extraction API. **Runtime is Bun (1.3+), not Node** — both repos.

## STRUCTURE

```
book-libary/
├── bookshelf-reader/          # Vue 3 SPA: flipbook reader
│   ├── src/
│   │   ├── main.js           # App bootstrap
│   │   ├── App.vue           # Scene state machine (desk ↔ reader)
│   │   ├── components/       # ReaderScene, BookFlipbook
│   │   ├── composables/      # useBookReader + modules/
│   │   └── styles/           # CSS files
│   ├── scripts/precompress.mjs  # brotli .br sidecars for dist (runs in build)
│   ├── public/vendor/js/     # turn.js, jquery (global scripts, NOT npm)
│   └── vite.config.js        # Dev port 5473, /api proxy to backend
└── server/                   # Bun.serve API: PDF extraction, page rendering
    ├── server.js             # Routes + cache/warmup/retry orchestration
    └── modules/              # constants, pdf, books, utils, renderPool, renderWorker
```

## COMMANDS (all Bun, no npm/node)

```bash
# Frontend
cd bookshelf-reader && bun install
cd bookshelf-reader && bun run dev      # bun --bun vite, port 5473
cd bookshelf-reader && bun run build    # vite build + brotli precompress of dist

# Backend
cd server && bun install
cd server && bun run dev                # bun --watch server.js
cd server && bun run start              # bun server.js
```

No test framework, no lint/format config. Syntax check backend without starting: `bun build --target=bun --outdir=/tmp/x server.js`.

## BACKEND ARCHITECTURE (post Bun migration)

- `Bun.serve({ routes, fetch })`: 6 GET API routes in `routes` object (method-mapped `{ GET: handler }` — plain function routes match ALL methods incl. OPTIONS, which broke CORS once); static files + CORS/OPTIONS in `fetch` fallback via `Bun.file()`
- **Render pool**: `renderPool.js` spawns `renderWorker.js` Bun Workers (default `min(CPU-1, 4)`, env `RENDER_POOL_SIZE`) for parallel pdfjs page rendering; worker caches 1 PDF doc handle (`doc.destroy()` on evict) + `page.cleanup()` after each render; falls back to main-thread render if pool fails
- **Page retry**: `/api/pdf-pages/<base>/<version>/page-N.webp` 404 → reverse-lookup PDF by hashed base name → version check → single-page re-render → serve. Dedup via `pageRetryJobs` Map
- **Memory**: heap limit 1GB; RSS limit env `MEMORY_RSS_LIMIT_MB` (default 3072) → clears caches + broadcasts `purge` to workers + `Bun.gc(true)`
- brotli `.br` sidecars for cached pages, batch-compressed AFTER render loop (not inline), served with `Content-Encoding: br`

## BUN-SPECIFIC GOTCHAS (hard-earned)

- **Bun Workers are THREADS, not processes** — they share process RSS. Per-worker memory limits are meaningless; use main-process RSS watchdog + purge broadcast
- **Importing `pdfjs-dist/legacy/build/pdf.mjs` breaks `os.availableParallelism()`** (returns undefined afterwards). Always guard: `Number.isFinite(ap) && ap > 0` else fall back to `os.cpus().length` (see `renderPool.js getCpuCount`)
- `bun build --compile` single binary is **NOT viable**: `@napi-rs/canvas` native `.node` can't embed → `DOMMatrix is not defined`, rendering broken
- `process.memoryUsage()` under Bun reports odd values (heapUsed > heapTotal); trust `ps`/`/proc` for real RSS
- Killing background `bun server.js` from the agent shell may be sandbox-blocked (`ChildProcess.kill`); use `pgrep` then `kill <pid>` in separate calls

## CONVENTIONS

- **jQuery global**: loaded via script tags in index.html, NOT npm import; turn.js relies on global `$`
- **Vue provide/inject**: shared state via `readerState` from useBookReader
- **Chinese error messages**: API responses in Chinese
- **No TypeScript**, vanilla JS everywhere
- **Ports**: backend 8088 (`server/modules/constants.js`), dev 5473 (`vite.config.js`)
- Env files (`.env.development` / `.env.production`) are gitignored

## ANTI-PATTERNS

- **DO NOT** re-add express/cors — backend is pure Bun.serve; deps are only `@napi-rs/canvas` + `pdfjs-dist`
- **DO NOT** import jQuery/turn.js via ES modules
- **DO NOT** remove `disableWorker: true` from pdfjs `getDocument` (Node/Bun env requires it)
- **DO NOT** revert `Bun.CryptoHasher`/`Bun.file`/`Bun.write` to node crypto/fs in hot paths without reason
- **DO NOT** put per-worker memory limits in renderWorker (threads share RSS — see gotchas)
- **DO NOT** change ports without updating vite proxy + env files
- Never git-commit unless user explicitly asks (user preference, stated 2026-08)

## DOCS

- Migration design spec: `docs/superpowers/specs/2026-08-07-bun-server-migration-design.md`
