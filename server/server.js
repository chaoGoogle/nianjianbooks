import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';
process.env.NODE_OPTIONS = '--input-type=module';

import {
  PORT,
  validateFileExt,
  sanitizeError,
  BOOKS_DIR,
  BOOK_THUMB_CACHE_DIR,
  PDF_PAGE_CACHE_DIR
} from './modules/constants.js';
import {
  loadPdfDocument,
  extractPdfText,
  renderPdfPageToWebpBuffer
} from './modules/pdf.js';
import { scanBooksProgressive } from './modules/books.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const brotliCompressAsync = promisify(brotliCompress);
const CPU_COUNT = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : (os.cpus()?.length || 4);
const PDF_CACHE_PAGE_CONCURRENCY = 1;
const PDF_CACHE_BOOK_CONCURRENCY = 1;

process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[process] unhandledRejection:', err?.message || err);
});

const app = express();
app.use(cors({
  origin: true,
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  maxAge: 86400
}));
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, '../public')));
app.use('/api/book-thumbs', express.static(BOOK_THUMB_CACHE_DIR, {
  immutable: true,
  maxAge: '365d'
}));
app.use('/api/pdf-pages', async (req, res, next) => {
  try {
    const relativePath = path.normalize(decodeURIComponent(req.path || '/')).replace(/^([/\\])+/, '');
    const sourcePath = path.join(PDF_PAGE_CACHE_DIR, relativePath);
    const normalizedRoot = path.resolve(PDF_PAGE_CACHE_DIR);
    const normalizedSource = path.resolve(sourcePath);

    if (!normalizedSource.startsWith(normalizedRoot)) {
      return res.status(400).end();
    }

    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (!acceptEncoding.includes('br')) {
      return next();
    }

    const compressedPath = `${normalizedSource}.br`;
    await fs.access(compressedPath);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Encoding', 'br');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
    createReadStream(compressedPath).pipe(res);
  } catch {
    next();
  }
});
app.use('/api/pdf-pages', express.static(PDF_PAGE_CACHE_DIR, {
  immutable: true,
  maxAge: '365d',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
  }
}));

const booksCache = {
  data: [],
  loaded: false,
  loadingPromise: null,
  loadedAt: 0,
  total: 0,
  processed: 0,
  warmupDone: false
};

function resetBooksCache() {
  booksCache.data = [];
  booksCache.loaded = false;
  booksCache.loadedAt = 0;
  booksCache.total = 0;
  booksCache.processed = 0;
}

function startBooksScan({ forceRefresh = false } = {}) {
  if (booksCache.loadingPromise && !forceRefresh) {
    return booksCache.loadingPromise;
  }

  resetBooksCache();

  booksCache.loadingPromise = scanBooksProgressive({
    onProgress({ books, total, processed }) {
      booksCache.data = books;
      booksCache.total = total;
      booksCache.processed = processed;
      booksCache.loadedAt = Date.now();
    }
  })
    .then(books => {
      booksCache.data = books;
      booksCache.loaded = true;
      booksCache.loadedAt = Date.now();
      booksCache.total = books.length;
      booksCache.processed = books.length;
      console.log(`[books-cache] ready: ${books.length} books cached`);
      return books;
    })
    .finally(() => {
      booksCache.loadingPromise = null;
    });

  return booksCache.loadingPromise;
}

function getBooksSnapshot({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    startBooksScan({ forceRefresh: true });
  } else if (!booksCache.loaded && !booksCache.loadingPromise) {
    startBooksScan();
  }

  return {
    books: booksCache.data,
    loaded: booksCache.loaded,
    loading: !!booksCache.loadingPromise,
    loadedAt: booksCache.loadedAt,
    total: booksCache.total,
    processed: booksCache.processed
  };
}

const WARMUP_ENABLED = process.env.WARMUP_ENABLED !== 'false';
let warmupRunning = false;
let warmupFailed = false;

async function warmBookLibrary() {
  if (!WARMUP_ENABLED) return;
  const startedAt = Date.now();
  try {
    const books = await startBooksScan({ forceRefresh: true });
    console.log(`[warmup] library warmed: ${books.length} pdfs, ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.error('[warmup] failed to warm library:', error.message);
  }
}

async function warmPdfLibraryCache() {
  if (!WARMUP_ENABLED) return;
  try {
    const books = booksCache.loaded ? booksCache.data : await startBooksScan();

    console.log(`[warmup] warming cache for all ${books.length} books`);

    let done = 0;
    for (const book of books.filter(b => !!b?.file)) {
      try {
        const resolved = await resolvePdfPath(book.file);
        if (resolved.error) continue;

        await ensurePdfPageImageCache(book.file, resolved.filePath, {
          width: 1600,
          eagerPageCount: Infinity
        });
        done += 1;
        console.log(`[warmup] cached: ${book.file} (${done}/${books.length})`);
      } catch (err) {
        console.error(`[warmup] failed to cache ${book.file}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[warmup] full cache warmup complete (${done}/${books.length})`);
  } catch (error) {
    console.error('[warmup] failed to warm pdf page cache:', error.message);
  }
}

function startBackgroundWarmup() {
  if (warmupRunning) return;
  warmupRunning = true;
  warmupFailed = false;

  warmBookLibrary()
    .then(() => warmPdfLibraryCache())
    .then(() => {
      booksCache.warmupDone = true;
      console.log('[warmup] all warmup tasks completed');
    })
    .catch(err => {
      console.error('[warmup] background warmup error:', err.message);
      warmupFailed = true;
    })
    .finally(() => {
      warmupRunning = false;
    });
}

function ensureWarmup() {
  if (!warmupRunning && !booksCache.warmupDone) {
    startBackgroundWarmup();
  }
}

async function resolvePdfPath(file) {
  if (!file || typeof file !== 'string') {
    return { error: { status: 400, message: '缺少 pdfPath 参数' } };
  }

  if (file.includes('..') || file.includes('/') || file.includes('\\')) {
    return { error: { status: 400, message: '仅支持 PDF 文件名，不支持路径' } };
  }

  if (!validateFileExt(file)) {
    return { error: { status: 400, message: '仅支持 PDF 文件' } };
  }
  const safeFileName = path.basename(file);
  const filePath = path.join(BOOKS_DIR, safeFileName);

  const resolvedPath = path.resolve(filePath);
  const normalizedBooksDir = path.resolve(BOOKS_DIR);

  if (!resolvedPath.startsWith(normalizedBooksDir + path.sep) && resolvedPath !== normalizedBooksDir) {
    return { error: { status: 400, message: '无效的文件路径' } };
  }

  try {
    await fs.access(filePath);
    return { filePath };
  } catch {
    return { error: { status: 404, message: 'PDF 文件不存在' } };
  }
}

function getPdfRenderVersion(pdfPath, stat) {
  return crypto
    .createHash('sha1')
    .update(`${path.basename(pdfPath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
}

function buildPdfPageImageUrl(file, pageNum, version, width = 1600) {
  const baseName = getPdfPageCacheBaseName(file);
  const pageFileName = `page-${String(pageNum).padStart(4, '0')}.webp`;
  return `/api/pdf-pages/${baseName}/${version}/${pageFileName}`;
}

function getPdfPageCacheBaseName(file) {
  const baseName = path.basename(String(file || ''), path.extname(String(file || '')));
  const normalizedBase = baseName
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/[_-]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
  const safeBase = /[a-zA-Z0-9]/.test(normalizedBase) ? normalizedBase : 'pdf';
  const hash = crypto.createHash('sha1').update(path.basename(String(file || 'pdf'))).digest('hex').slice(0, 12);
  return `${safeBase}-${hash}`;
}

function getPdfPageCacheDir(file, version) {
  return path.join(PDF_PAGE_CACHE_DIR, getPdfPageCacheBaseName(file), version);
}

function getPdfPageCacheFilePath(file, version, pageNum) {
  return path.join(getPdfPageCacheDir(file, version), `page-${String(pageNum).padStart(4, '0')}.webp`);
}

async function ensureBrotliSidecar(filePath) {
  const compressedPath = `${filePath}.br`;

  let sourceStat;
  try {
    sourceStat = await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  try {
    const compressedStat = await fs.stat(compressedPath);
    if (compressedStat.size > 0 && compressedStat.mtimeMs >= sourceStat.mtimeMs) {
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const buffer = await fs.readFile(filePath);
  const compressedBuffer = await brotliCompressAsync(buffer);
  await fs.writeFile(compressedPath, compressedBuffer);
}

async function runWithConcurrency(items, limit, worker) {
  const queue = Array.isArray(items) ? items : [];
  if (!queue.length) return [];

  const safeLimit = Math.max(1, Math.min(limit || 1, queue.length));
  const results = new Array(queue.length);
  let nextIndex = 0;

  async function consume() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= queue.length) return;
      results[currentIndex] = await worker(queue[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: safeLimit }, () => consume()));
  return results;
}

async function ensurePdfPageImageCache(file, pdfPath, { width = 1600, eagerPageCount = Infinity } = {}) {
  const pdfStat = await fs.stat(pdfPath);
  const version = getPdfRenderVersion(pdfPath, pdfStat);
  const pdf = await loadPdfDocument(pdfPath);
  const sourcePages = pdf.numPages || 0;
  const cacheDir = getPdfPageCacheDir(file, version);
  const urls = new Array(sourcePages);

  await fs.mkdir(cacheDir, { recursive: true });

  let renderedCount = 0;

  await runWithConcurrency(
    Array.from({ length: sourcePages }, (_, index) => index + 1),
    PDF_CACHE_PAGE_CONCURRENCY,
    async pageNum => {
      const pageFilePath = getPdfPageCacheFilePath(file, version, pageNum);
      let cacheReady = false;

      try {
        const fileStat = await fs.stat(pageFilePath);
        cacheReady = fileStat.size > 0 && fileStat.mtimeMs >= pdfStat.mtimeMs;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (!cacheReady && pageNum <= eagerPageCount) {
        try {
          const buffer = await renderPdfPageToWebpBuffer(pdfPath, pageNum, width);
          await fs.writeFile(pageFilePath, buffer);
        } catch (renderErr) {
          console.error(`[warmup] skip page ${pageNum} of ${file}: ${renderErr.message}`);
          urls[pageNum - 1] = null;
          return;
        }
      }

      if (cacheReady || pageNum <= eagerPageCount) {
        try {
          await ensureBrotliSidecar(pageFilePath);
        } catch (brErr) {
          console.error(`[warmup] skip brotli ${file} p${pageNum}: ${brErr.message}`);
        }
      }

      urls[pageNum - 1] = buildPdfPageImageUrl(file, pageNum, version, width);

      renderedCount += 1;
      if (renderedCount % 10 === 0) {
        await new Promise(r => setTimeout(r, 50));
      }
    }
  );

  return { urls, sourcePages, version };
}

async function getPdfPageImageList(file, pdfPath) {
  return ensurePdfPageImageCache(file, pdfPath, { width: 1600, eagerPageCount: 0 });
}

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    booksLoaded: booksCache.loaded,
    booksCount: booksCache.data.length,
    warmupDone: booksCache.warmupDone,
    warmupRunning
  });
});

app.get('/api/books', async (req, res) => {
  try {
    ensureWarmup();
    const forceRefresh = req.query.refresh === '1';
    const snapshot = getBooksSnapshot({ forceRefresh });
    res.json({
      success: true,
      data: snapshot.books,
      cached: !forceRefresh,
      loadedAt: snapshot.loadedAt,
      complete: snapshot.loaded,
      loading: snapshot.loading,
      progress: {
        processed: snapshot.processed,
        total: snapshot.total
      }
    });
  } catch (error) {
    console.error('[api/books] error:', error);
    res.status(500).json({ success: false, message: '扫描书籍目录失败', error: sanitizeError(error) });
  }
});

app.get('/api/file/pages', async (req, res) => {
  try {
    const { file } = req.query;
    const resolved = await resolvePdfPath(file);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }

    const pdf = await loadPdfDocument(resolved.filePath);
    const sourcePages = pdf.numPages;
    res.json({
      success: true,
      data: {
        totalPages: sourcePages,
        sourcePages,
        type: 'pdf',
        renderMode: 'page'
      }
    });
  } catch (error) {
    console.error('[api/file/pages] error:', error);
    res.status(500).json({ success: false, message: '读取 PDF 页数失败', error: sanitizeError(error) });
  }
});

app.get('/api/file/extract', async (req, res) => {
  try {
    const { file, page, pageSize } = req.query;
    const resolved = await resolvePdfPath(file);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }

    const pageNum = Number.parseInt(page, 10) || 1;
    const pageSizeNum = Math.min(Math.max(Number.parseInt(pageSize, 10) || 10, 1), 100);
    const result = await extractPdfText(resolved.filePath, pageNum, pageNum + pageSizeNum - 1);

    res.json({ success: true, data: { ...result, type: 'pdf' } });
  } catch (error) {
    console.error('[api/file/extract] error:', error);
    res.status(500).json({ success: false, message: '提取 PDF 文本失败', error: sanitizeError(error) });
  }
});

app.get('/api/file/page-image', async (req, res) => {
  try {
    const { file, page, width } = req.query;
    const resolved = await resolvePdfPath(file);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }

    const pageNum = Math.max(Number.parseInt(page, 10) || 1, 1);
    const targetWidth = Math.min(Math.max(Number.parseInt(width, 10) || 1600, 280), 2400);
    const imageBuffer = await renderPdfPageToWebpBuffer(resolved.filePath, pageNum, targetWidth);
    const stat = await fs.stat(resolved.filePath);
    const version = getPdfRenderVersion(resolved.filePath, stat);

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${version}-${pageNum}-${targetWidth}"`);
    res.send(imageBuffer);
  } catch (error) {
    console.error('[api/file/page-image] error:', error);
    res.status(500).json({ success: false, message: '生成 PDF 页面图片失败', error: sanitizeError(error) });
  }
});

app.get('/api/process', async (req, res) => {
  try {
    const { pdfPath } = req.query;
    const resolved = await resolvePdfPath(pdfPath);
    if (resolved.error) {
      return res.status(resolved.error.status).json({ success: false, message: resolved.error.message });
    }

    const processed = await getPdfPageImageList(pdfPath, resolved.filePath);
    res.json({
      success: true,
      data: {
        urls: processed.urls,
        sourcePages: processed.sourcePages,
        pageCount: processed.sourcePages,
        version: processed.version
      }
    });
  } catch (error) {
    console.error('[api/process] error:', error);
    res.status(500).json({ success: false, message: '生成 PDF 页面图片失败', error: sanitizeError(error) });
  }
});

app.listen(PORT, () => {
  console.log(`PDF Server running on http://localhost:${PORT}`);
  console.log(`Books directory: ${BOOKS_DIR}`);
  startBackgroundWarmup();
});
