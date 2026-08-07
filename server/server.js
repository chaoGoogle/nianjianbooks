import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';
import { brotliCompress } from 'zlib';
import { promisify } from 'util';

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
  renderPdfPageToWebpBuffer,
  clearPdfPageCache
} from './modules/pdf.js';
import { scanBooksProgressive } from './modules/books.js';
import { renderPageInWorker, isRenderPoolAvailable, getRenderWorkerMemory, purgeRenderWorkers, RENDER_POOL_SIZE } from './modules/renderPool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const brotliCompressAsync = promisify(brotliCompress);
const CPU_COUNT = (() => {
  const parallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : undefined;
  if (Number.isFinite(parallelism) && parallelism > 0) return parallelism;
  return os.cpus()?.length || 4;
})();
const PDF_CACHE_PAGE_CONCURRENCY = 1;
const PDF_CACHE_BOOK_CONCURRENCY = 1;
const MEMORY_LIMIT = 1024 * 1024 * 1024;
const MEMORY_RSS_LIMIT = Math.max(1024, parseInt(process.env.MEMORY_RSS_LIMIT_MB || '3072', 10)) * 1024 * 1024;
const MEMORY_CHECK_INTERVAL = 30_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

function withCors(headers = {}) {
  return { ...CORS_HEADERS, ...headers };
}

function jsonResponse(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: withCors(headers) });
}

function logRequest(req) {
  console.log(`[${new Date().toISOString()}] ${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`);
}

function withLog(handler) {
  return (req) => {
    logRequest(req);
    return handler(req);
  };
}

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers
  };
}

function formatBytes(bytes) {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `${mb}MB`;
}

function checkMemory() {
  const mem = getMemoryUsage();
  const heapMB = mem.heapUsed;
  const rssMB = mem.rss;

  if (heapMB > MEMORY_LIMIT) {
    console.warn(`[memory] heap ${formatBytes(heapMB)} exceeds limit ${formatBytes(MEMORY_LIMIT)}, clearing caches and triggering GC...`);
    clearPdfPageCache();
    Bun.gc(true);
    const after = getMemoryUsage();
    console.log(`[memory] GC done: heap ${formatBytes(after.heapUsed)} (freed ${formatBytes(heapMB - after.heapUsed)})`);
  }

  if (rssMB > MEMORY_RSS_LIMIT) {
    console.warn(`[memory] RSS ${formatBytes(rssMB)} exceeds limit ${formatBytes(MEMORY_RSS_LIMIT)}, clearing caches, purging render workers and triggering GC...`);
    clearPdfPageCache();
    purgeRenderWorkers();
    Bun.gc(true);
    const after = getMemoryUsage();
    console.log(`[memory] GC done: RSS ${formatBytes(after.rss)} (freed ${formatBytes(rssMB - after.rss)})`);
  }
}

setInterval(checkMemory, MEMORY_CHECK_INTERVAL);
checkMemory();

process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[process] unhandledRejection:', err?.message || err);
});

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
    let skipped = 0;
    for (const book of books.filter(b => !!b?.file)) {
      try {
        const resolved = await resolvePdfPath(book.file);
        if (resolved.error) continue;

        const result = await ensurePdfPageImageCache(book.file, resolved.filePath, {
          width: 2400,
          eagerPageCount: Infinity
        });
        done += 1;
        if (result.renderedCount === 0) {
          skipped += 1;
          console.log(`[warmup] skipped (cached): ${book.file} (${done}/${books.length})`);
        } else {
          console.log(`[warmup] cached: ${book.file} (${done}/${books.length})`);
        }
      } catch (err) {
        console.error(`[warmup] failed to cache ${book.file}:`, err.message);
      }
    }

    console.log(`[warmup] full cache warmup complete (${done}/${books.length}, ${skipped} skipped)`);
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

function sha1Hex(input) {
  const hasher = new Bun.CryptoHasher('sha1');
  hasher.update(input);
  return hasher.digest('hex');
}

function getPdfRenderVersion(pdfPath, stat) {
  return sha1Hex(`${path.basename(pdfPath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`).slice(0, 16);
}

function buildPdfPageImageUrl(file, pageNum, version, width = 2400) {
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
  const hash = sha1Hex(path.basename(String(file || 'pdf'))).slice(0, 12);
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

  const buffer = await Bun.file(filePath).arrayBuffer();
  const compressedBuffer = await brotliCompressAsync(Buffer.from(buffer));
  await Bun.write(compressedPath, compressedBuffer);
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

async function renderPageForCache(pdfPath, pageNum, width) {
  const workerResult = renderPageInWorker(pdfPath, pageNum, width);
  if (workerResult) return workerResult;
  return renderPdfPageToWebpBuffer(pdfPath, pageNum, width);
}

async function ensurePdfPageImageCache(file, pdfPath, { width = 2400, eagerPageCount = Infinity } = {}) {
  const pdfStat = await fs.stat(pdfPath);
  const version = getPdfRenderVersion(pdfPath, pdfStat);
  const pdf = await loadPdfDocument(pdfPath);
  const sourcePages = pdf.numPages || 0;
  const cacheDir = getPdfPageCacheDir(file, version);
  const urls = new Array(sourcePages);

  if (sourcePages === 0) return { urls: [], sourcePages: 0, version };

  let allCached = true;
  for (let i = 1; i <= sourcePages; i++) {
    const pageFilePath = getPdfPageCacheFilePath(file, version, i);
    try {
      const fileStat = await fs.stat(pageFilePath);
      if (fileStat.size === 0 || fileStat.mtimeMs < pdfStat.mtimeMs) {
        allCached = false;
        break;
      }
    } catch {
      allCached = false;
      break;
    }
  }

  if (allCached) {
    console.log(`[cache] ${file}: all ${sourcePages} pages cached, skipping`);
    for (let i = 0; i < sourcePages; i++) {
      urls[i] = buildPdfPageImageUrl(file, i + 1, version, width);
    }
    return { urls, sourcePages, version };
  }

  await fs.mkdir(cacheDir, { recursive: true });

  let renderedCount = 0;
  let skippedCount = 0;
  const brotliTargets = [];

  console.log(`[cache] ${file}: ${sourcePages} pages, eagerPageCount=${eagerPageCount}`);

  const pageConcurrency = isRenderPoolAvailable() ? RENDER_POOL_SIZE : PDF_CACHE_PAGE_CONCURRENCY;

  await runWithConcurrency(
    Array.from({ length: sourcePages }, (_, index) => index + 1),
    pageConcurrency,
    async pageNum => {
      const pageFilePath = getPdfPageCacheFilePath(file, version, pageNum);
      let cacheReady = false;

      try {
        const fileStat = await fs.stat(pageFilePath);
        cacheReady = fileStat.size > 0 && fileStat.mtimeMs >= pdfStat.mtimeMs;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      if (cacheReady) {
        skippedCount++;
      } else if (pageNum <= eagerPageCount) {
        try {
          const buffer = await renderPageForCache(pdfPath, pageNum, width);
          await Bun.write(pageFilePath, buffer);
          renderedCount++;
        } catch (renderErr) {
          console.error(`[cache] skip page ${pageNum} of ${file}: ${renderErr.message}`);
          urls[pageNum - 1] = null;
          return;
        }
      }

      if (cacheReady || pageNum <= eagerPageCount) {
        brotliTargets.push(pageFilePath);
      }

      urls[pageNum - 1] = buildPdfPageImageUrl(file, pageNum, version, width);

      if (renderedCount % 10 === 0 && renderedCount > 0) {
        console.log(`[cache] ${file}: rendered ${renderedCount}/${sourcePages} pages`);
      }
    }
  );

  const BROTLI_CONCURRENCY = Math.min(4, CPU_COUNT);
  await runWithConcurrency(brotliTargets, BROTLI_CONCURRENCY, async pageFilePath => {
    try {
      await ensureBrotliSidecar(pageFilePath);
    } catch (brErr) {
      console.error(`[cache] skip brotli ${file} ${path.basename(pageFilePath)}: ${brErr.message}`);
    }
  });

  console.log(`[cache] ${file}: done - rendered=${renderedCount}, skipped=${skippedCount}, total=${sourcePages}`);
  return { urls, sourcePages, version };
}

const backgroundRenderJobs = new Map();

async function getPdfPageImageList(file, pdfPath) {
  return ensurePdfPageImageCache(file, pdfPath, { width: 2400, eagerPageCount: 0 });
}

async function startBackgroundRender(file, pdfPath) {
  if (backgroundRenderJobs.has(file)) {
    console.log(`[background-render] ${file} already in progress, skipping`);
    return;
  }
  backgroundRenderJobs.set(file, { startedAt: Date.now(), pages: 0 });
  console.log(`[background-render] ${file} starting...`);
  try {
    await ensurePdfPageImageCache(file, pdfPath, { width: 2400, eagerPageCount: Infinity });
    console.log(`[background-render] ${file} done`);
  } catch (err) {
    console.error(`[background-render] ${file} failed:`, err.message);
  } finally {
    backgroundRenderJobs.delete(file);
  }
}

async function handleHealth() {
  const mem = getMemoryUsage();
  return jsonResponse({
    success: true,
    status: 'ok',
    booksLoaded: booksCache.loaded,
    booksCount: booksCache.data.length,
    warmupDone: booksCache.warmupDone,
    warmupRunning,
    backgroundRenders: Array.from(backgroundRenderJobs.keys()),
    pageRetries: pageRetryJobs.size,
    renderWorkers: {
      size: RENDER_POOL_SIZE,
      memory: getRenderWorkerMemory().map(w => `${formatBytes(w.rss || 0)}`)
    },
    memory: {
      heapUsed: formatBytes(mem.heapUsed),
      heapTotal: formatBytes(mem.heapTotal),
      rss: formatBytes(mem.rss),
      limit: formatBytes(MEMORY_LIMIT),
      heapPercent: ((mem.heapUsed / MEMORY_LIMIT) * 100).toFixed(1) + '%'
    }
  });
}

async function handleBooks(req) {
  try {
    ensureWarmup();
    const forceRefresh = new URL(req.url).searchParams.get('refresh') === '1';
    const snapshot = getBooksSnapshot({ forceRefresh });
    return jsonResponse({
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
    return jsonResponse({ success: false, message: '扫描书籍目录失败', error: sanitizeError(error) }, 500);
  }
}

async function handleBookByName(req) {
  try {
    ensureWarmup();
    const { name } = req.params;
    const snapshot = getBooksSnapshot();
    const book = snapshot.books.find(b => {
      const fileName = String(b.file || '').replace(/\.pdf$/i, '');
      return fileName === name;
    });
    if (!book) {
      return jsonResponse({ success: false, message: `未找到名为 "${name}" 的书籍` }, 404);
    }
    return jsonResponse({ success: true, data: book });
  } catch (error) {
    console.error('[api/books/by-name] error:', error);
    return jsonResponse({ success: false, message: '查找书籍失败', error: sanitizeError(error) }, 500);
  }
}

async function handleFilePages(req) {
  try {
    const file = new URL(req.url).searchParams.get('file');
    const resolved = await resolvePdfPath(file);
    if (resolved.error) {
      return jsonResponse({ success: false, message: resolved.error.message }, resolved.error.status);
    }

    const pdf = await loadPdfDocument(resolved.filePath);
    const sourcePages = pdf.numPages;
    return jsonResponse({
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
    return jsonResponse({ success: false, message: '读取 PDF 页数失败', error: sanitizeError(error) }, 500);
  }
}

async function handleFilePageImage(req) {
  try {
    const params = new URL(req.url).searchParams;
    const file = params.get('file');
    const page = params.get('page');
    const width = params.get('width');
    const resolved = await resolvePdfPath(file);
    if (resolved.error) {
      return jsonResponse({ success: false, message: resolved.error.message }, resolved.error.status);
    }

    const pageNum = Math.max(Number.parseInt(page, 10) || 1, 1);
    const targetWidth = Math.min(Math.max(Number.parseInt(width, 10) || 2400, 280), 3200);
    const imageBuffer = await renderPdfPageToWebpBuffer(resolved.filePath, pageNum, targetWidth);
    const stat = await fs.stat(resolved.filePath);
    const version = getPdfRenderVersion(resolved.filePath, stat);

    return new Response(imageBuffer, {
      headers: withCors({
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"${version}-${pageNum}-${targetWidth}"`
      })
    });
  } catch (error) {
    console.error('[api/file/page-image] error:', error);
    return jsonResponse({ success: false, message: '生成 PDF 页面图片失败', error: sanitizeError(error) }, 500);
  }
}

async function handleProcess(req) {
  try {
    const pdfPath = new URL(req.url).searchParams.get('pdfPath');
    const resolved = await resolvePdfPath(pdfPath);
    if (resolved.error) {
      return jsonResponse({ success: false, message: resolved.error.message }, resolved.error.status);
    }

    const processed = await getPdfPageImageList(pdfPath, resolved.filePath);
    startBackgroundRender(pdfPath, resolved.filePath);
    return jsonResponse({
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
    return jsonResponse({ success: false, message: '生成 PDF 页面图片失败', error: sanitizeError(error) }, 500);
  }
}

async function serveStaticFile(rootDir, requestPath, headers = {}) {
  let relativePath;
  try {
    relativePath = path.normalize(decodeURIComponent(requestPath || '/')).replace(/^([/\\])+/, '');
  } catch {
    return new Response(null, { status: 400, headers: withCors() });
  }

  const sourcePath = path.join(rootDir, relativePath);
  const normalizedRoot = path.resolve(rootDir);
  const normalizedSource = path.resolve(sourcePath);

  if (!normalizedSource.startsWith(normalizedRoot)) {
    return new Response(null, { status: 400, headers: withCors() });
  }

  const file = Bun.file(normalizedSource);
  if (!(await file.exists())) {
    return null;
  }
  return new Response(file, { headers: withCors(headers) });
}

const pageRetryJobs = new Map();

async function findBookFileByCacheBaseName(baseName) {
  try {
    const files = await fs.readdir(BOOKS_DIR);
    for (const file of files) {
      if (!validateFileExt(file)) continue;
      if (getPdfPageCacheBaseName(file) === baseName) {
        return file;
      }
    }
  } catch {}
  return null;
}

async function retryRenderSinglePage(baseName, version, pageNum) {
  const retryKey = `${baseName}/${version}/${pageNum}`;
  if (pageRetryJobs.has(retryKey)) {
    return pageRetryJobs.get(retryKey);
  }

  const job = (async () => {
    const file = await findBookFileByCacheBaseName(baseName);
    if (!file) return null;

    const resolved = await resolvePdfPath(file);
    if (resolved.error) return null;

    const stat = await fs.stat(resolved.filePath);
    const currentVersion = getPdfRenderVersion(resolved.filePath, stat);
    if (currentVersion !== version) {
      console.warn(`[page-retry] ${file} version mismatch (requested=${version}, current=${currentVersion}), skip`);
      return null;
    }

    console.log(`[page-retry] ${file} page ${pageNum}: re-rendering single page`);
    const buffer = await renderPageForCache(resolved.filePath, pageNum, 2400);

    const pageFilePath = getPdfPageCacheFilePath(file, version, pageNum);
    await fs.mkdir(path.dirname(pageFilePath), { recursive: true });
    await Bun.write(pageFilePath, buffer);
    try {
      await ensureBrotliSidecar(pageFilePath);
    } catch (brErr) {
      console.error(`[page-retry] brotli failed ${file} p${pageNum}: ${brErr.message}`);
    }
    console.log(`[page-retry] ${file} page ${pageNum}: done`);
    return pageFilePath;
  })()
    .catch(err => {
      console.error(`[page-retry] failed ${retryKey}:`, err.message);
      return null;
    })
    .finally(() => {
      pageRetryJobs.delete(retryKey);
    });

  pageRetryJobs.set(retryKey, job);
  return job;
}

const PDF_PAGE_STATIC_HEADERS = {
  'Content-Type': 'image/webp',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Vary': 'Accept-Encoding'
};

async function servePdfPageFile(requestPath, acceptEncoding) {
  let relativePath;
  try {
    relativePath = path.normalize(decodeURIComponent(requestPath || '/')).replace(/^([/\\])+/, '');
  } catch {
    return new Response(null, { status: 400, headers: withCors() });
  }

  const sourcePath = path.join(PDF_PAGE_CACHE_DIR, relativePath);
  const normalizedRoot = path.resolve(PDF_PAGE_CACHE_DIR);
  const normalizedSource = path.resolve(sourcePath);

  if (!normalizedSource.startsWith(normalizedRoot)) {
    return new Response(null, { status: 400, headers: withCors() });
  }

  if (acceptEncoding.includes('br')) {
    const compressedFile = Bun.file(`${normalizedSource}.br`);
    if (await compressedFile.exists()) {
      return new Response(compressedFile, {
        headers: withCors({ ...PDF_PAGE_STATIC_HEADERS, 'Content-Encoding': 'br' })
      });
    }
  }

  const file = Bun.file(normalizedSource);
  if (await file.exists()) {
    return new Response(file, { headers: withCors(PDF_PAGE_STATIC_HEADERS) });
  }

  const retryMatch = relativePath.match(/^([^/]+)\/([^/]+)\/page-(\d+)\.webp$/);
  if (retryMatch) {
    const [, baseName, version, pageNumStr] = retryMatch;
    const pageNum = Number.parseInt(pageNumStr, 10);
    const retriedPath = await retryRenderSinglePage(baseName, version, pageNum);
    if (retriedPath) {
      if (acceptEncoding.includes('br')) {
        const compressedFile = Bun.file(`${retriedPath}.br`);
        if (await compressedFile.exists()) {
          return new Response(compressedFile, {
            headers: withCors({ ...PDF_PAGE_STATIC_HEADERS, 'Content-Encoding': 'br' })
          });
        }
      }
      const retriedFile = Bun.file(retriedPath);
      if (await retriedFile.exists()) {
        return new Response(retriedFile, { headers: withCors(PDF_PAGE_STATIC_HEADERS) });
      }
    }
  }

  return new Response('Not Found', { status: 404, headers: withCors() });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  routes: {
    '/api/health': { GET: withLog(handleHealth) },
    '/api/books': { GET: withLog(handleBooks) },
    '/api/books/by-name/:name': { GET: withLog(handleBookByName) },
    '/api/file/pages': { GET: withLog(handleFilePages) },
    '/api/file/page-image': { GET: withLog(handleFilePageImage) },
    '/api/process': { GET: withLog(handleProcess) }
  },
  async fetch(req) {
    logRequest(req);
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: withCors() });
    }

    if (pathname.startsWith('/api/book-thumbs/')) {
      const res = await serveStaticFile(
        BOOK_THUMB_CACHE_DIR,
        pathname.slice('/api/book-thumbs'.length),
        { 'Cache-Control': 'public, max-age=31536000, immutable' }
      );
      if (res) return res;
      return new Response('Not Found', { status: 404, headers: withCors() });
    }

    if (pathname.startsWith('/api/pdf-pages/')) {
      const acceptEncoding = String(req.headers.get('accept-encoding') || '');
      return servePdfPageFile(pathname.slice('/api/pdf-pages'.length), acceptEncoding);
    }

    const res = await serveStaticFile(path.join(__dirname, '../public'), pathname);
    if (res) return res;
    return new Response('Not Found', { status: 404, headers: withCors() });
  }
});

console.log(`PDF Server running on http://localhost:${server.port}`);
console.log(`Books directory: ${BOOKS_DIR}`);
startBackgroundWarmup();
