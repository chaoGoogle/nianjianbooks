# BOOKSHELF-READER

Vue 3 + Vite SPA for bookshelf display and page-flip reading.

## STRUCTURE

```
bookshelf-reader/
├── src/
│   ├── main.js              # App bootstrap (createApp, mount)
│   ├── App.vue              # Root: scene state machine (desk ↔ reader), transition mask
│   ├── components/
│   │   ├── DeskScene.vue    # Book grid with card animations, theme toggle
│   │   ├── ReaderScene.vue  # Top bar + flipbook + video panel (PiP support)
│   │   └── BookFlipbook.vue # turn.js integration, page rendering, swipe/keyboard nav
│   ├── composables/
│   │   └── useBookReader.js # Core state: API calls, page splitting, turn.js bridge
│   └── assets/
│       └── style.css        # All styles (dark-mode via .dark-mode on :root)
├── public/
│   ├── vendor/js/           # turn.js, jquery.min.4.js (loaded as global scripts)
│   ├── vendor/pics/         # wood.png texture
│   └── bj.png               # Background image
├── index.html               # Entry HTML (loads jQuery + turn.js via <script>)
├── vite.config.js           # Port 80, @ alias, turnbook-js alias, /api proxy
├── .env.development         # VITE_API_BASE=http://192.168.22.113:3000
└── .env.production          # VITE_API_BASE=http://localhost:3000
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a new scene | `App.vue` | Scene state machine with transition mask timing constants |
| Modify book grid UI | `DeskScene.vue` | Book cards, open/close animations |
| Change reading experience | `BookFlipbook.vue` + `useBookReader.js` | Flipbook init/destroy, page rendering, turn events |
| Add API endpoint usage | `useBookReader.js` | All API calls go through axios with `API_BASE + '/api'` prefix |
| Adjust page layout math | `useBookReader.js` → `splitContentToPages()` | DOM-ruler-based pagination; constants at top: PAGE_FONT_SIZE=15, LINE_HEIGHT=1.95 |
| Video/PiP features | `ReaderScene.vue` | Native PiP + fake-PiP fallback for Android |
| Dark mode | `style.css` + `useBookReader.js` → `toggleTheme()` | Toggles `.dark-mode` on `<html>`, persists in localStorage |

## CONVENTIONS

- jQuery loaded as global (`window.$`) via index.html script tags — NOT imported via npm
- turn.js accessed through the same global jQuery instance
- State shared between components via Vue `provide/inject` (`readerState` from useBookReader)
- API base URL constructed from `import.meta.env.VITE_API_BASE` + `/api`
- Debug logging controlled by `DEBUG_MODE` flag in useBookReader.js (default: false)

## ANTI-PATTERNS (THIS PROJECT)

- **DO NOT** import jQuery or turn.js via ES module import — they rely on global `$`
- **DO NOT** remove the `turnbook-js` vite alias — it resolves to vendored turn.js
- **DO NOT** change port 80 in vite.config.js without updating all env configs
- **NEVER** directly manipulate DOM outside useBookReader.js — all jQuery usage is centralized there

## NOTES

- `useBookReader.js` is ~900 lines and handles: API communication, page splitting, turn.js lifecycle, background preloading, TOC mapping, theme state
- The flipbook uses `display: 'double'` in landscape, `'single'` in portrait (calculated by `calculatePageSize()`)
- Android viewport fix: `--vh` CSS custom property set from `visualViewport.height`
- Book video panel supports native Picture-in-Picture with a draggable fake-PiP fallback for browsers that don't support it