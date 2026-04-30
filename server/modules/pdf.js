import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { fileURLToPath, pathToFileURL } from 'url';
import { BOOK_THUMB_CACHE_DIR } from './constants.js';
import { escHtml, normalizeBookTitle, pickPdfTitle, parsePdfFilename } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

export function buildPdfPlaceholderCover(title) {
  const safeTitle = escHtml(title || 'PDF');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="280" height="392" viewBox="0 0 280 392"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#5a2218"/><stop offset="100%" stop-color="#2a0f0b"/></linearGradient></defs><rect width="280" height="392" rx="12" fill="url(#bg)"/><rect x="18" y="18" width="244" height="356" rx="8" fill="none" stroke="rgba(255,230,190,0.28)"/><text x="140" y="88" text-anchor="middle" fill="#ffd7a8" font-size="34" font-family="Georgia, serif" letter-spacing="6">PDF</text><foreignObject x="34" y="118" width="212" height="210"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;height:100%;align-items:center;justify-content:center;color:#fff3dc;font-size:22px;line-height:1.6;text-align:center;font-family:'Microsoft YaHei',serif;word-break:break-word;">${safeTitle}</div></foreignObject></svg>`)}`;
}

function buildPdfPlaceholderCoverSvg(title) {
  return decodeURIComponent(buildPdfPlaceholderCover(title).replace('data:image/svg+xml;charset=utf-8,', ''));
}

const MAX_PDF_DOCUMENT_CACHE_SIZE = Math.max(1, parseInt(process.env.MAX_PDF_DOCUMENT_CACHE_SIZE || '10', 10));
const MAX_PDF_PAGE_BUFFER_CACHE_SIZE = Math.max(1, parseInt(process.env.MAX_PDF_PAGE_BUFFER_CACHE_SIZE || '50', 10));
const MAX_PDF_IMAGE_CACHE_SIZE = Math.max(1, parseInt(process.env.MAX_PDF_IMAGE_CACHE_SIZE || '100', 10));
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '300000', 10);
class LRUCache extends Map {
  constructor(maxSize, ttlMs = CACHE_TTL_MS) {
    super();
    this.maxSize = Math.max(1, maxSize);
    this.ttlMs = ttlMs;
    this.timestamps = new Map();
  }

  set(key, value) {
    if (this.has(key)) {
      this.delete(key);
    }
    super.set(key, value);
    this.timestamps.set(key, Date.now());

    while (this.size > this.maxSize) {
      const firstKey = this.keys().next().value;
      this.delete(firstKey);
    }
    return this;
  }

  get(key) {
    if (!this.has(key)) return undefined;

    const timestamp = this.timestamps.get(key);
    if (timestamp && Date.now() - timestamp > this.ttlMs) {
      this.delete(key);
      return undefined;
    }

    const value = super.get(key);
    this.delete(key);
    super.set(key, value);
    this.timestamps.set(key, Date.now());
    return value;
  }

  has(key) {
    if (!super.has(key)) return false;
    const timestamp = this.timestamps.get(key);
    if (timestamp && Date.now() - timestamp > this.ttlMs) {
      this.delete(key);
      return false;
    }
    return true;
  }

  clear() {
    super.clear();
    this.timestamps.clear();
  }

  getSize() {
    return this.size;
  }

  cleanup() {
    const now = Date.now();
    for (const key of this.keys()) {
      const timestamp = this.timestamps.get(key);
      if (timestamp && now - timestamp > this.ttlMs) {
        this.delete(key);
      }
    }
  }

  delete(key) {
    this.timestamps.delete(key);
    return super.delete(key);
  }
}

const pdfDocumentCache = new LRUCache(MAX_PDF_DOCUMENT_CACHE_SIZE);
const pdfPageBufferCache = new LRUCache(MAX_PDF_PAGE_BUFFER_CACHE_SIZE);
const pdfPageBufferPromiseCache = new Map();
const pdfImageCache = new LRUCache(MAX_PDF_IMAGE_CACHE_SIZE);
const pdfSpreadCache = new LRUCache(30);

setInterval(() => {
  pdfDocumentCache.cleanup();
  pdfPageBufferCache.cleanup();
  pdfImageCache.cleanup();
}, 600000).unref();

async function getPdfDocumentCacheKey(pdfPath) {
  const stat = await fs.stat(pdfPath);
  return `${pdfPath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

export async function loadPdfDocument(pdfPath) {
  const cacheKey = await getPdfDocumentCacheKey(pdfPath);
  if (pdfDocumentCache.has(cacheKey)) {
    return pdfDocumentCache.get(cacheKey);
  }

  const loadPromise = fs.readFile(pdfPath)
    .then(fileBuffer => getDocument({
      data: new Uint8Array(fileBuffer),
      disableWorker: true
    }).promise)
    .catch(error => {
      pdfDocumentCache.delete(cacheKey);
      throw error;
    });

  pdfDocumentCache.set(cacheKey, loadPromise);
  return loadPromise;
}

async function waitForPdfRender(renderTask) {
  if (!renderTask) return;
  if (typeof renderTask.promise?.then === 'function') {
    await renderTask.promise;
    return;
  }
  await renderTask;
}

function normalizeRenderWidth(targetWidth, fallbackWidth) {
  const preferredWidth = Number.isFinite(targetWidth) && targetWidth > 0
    ? targetWidth
    : fallbackWidth;
  return Math.min(Math.max(Math.round(preferredWidth), 280), 2400);
}

export async function renderPdfPageToPngBuffer(pdfPath, pageNum = 1, targetWidth = 220) {
  const renderWidth = normalizeRenderWidth(targetWidth, targetWidth);
  const cached = getPdfPageBufferFromCache(pdfPath, pageNum, renderWidth, 'png');
  if (cached) {
    return cached;
  }

  const promiseKey = getBufferCacheKey(pdfPath, pageNum, renderWidth, 'png');
  if (pdfPageBufferPromiseCache.has(promiseKey)) {
    return pdfPageBufferPromiseCache.get(promiseKey);
  }

  const renderPromise = loadPdfDocument(pdfPath)
    .then(pdf => renderPdfPageFromDocumentToPngBuffer(pdf, pageNum, renderWidth))
    .then(buffer => {
      setPdfPageBufferToCache(pdfPath, pageNum, renderWidth, buffer, 'png');
      pdfPageBufferPromiseCache.delete(promiseKey);
      return buffer;
    })
    .catch(error => {
      pdfPageBufferPromiseCache.delete(promiseKey);
      throw error;
    });

  pdfPageBufferPromiseCache.set(promiseKey, renderPromise);
  return renderPromise;
}

export async function renderPdfPageToWebpBuffer(pdfPath, pageNum = 1, targetWidth = 220) {
  const renderWidth = normalizeRenderWidth(targetWidth, targetWidth);
  const cached = getPdfPageBufferFromCache(pdfPath, pageNum, renderWidth, 'webp');
  if (cached) {
    return cached;
  }

  const promiseKey = getBufferCacheKey(pdfPath, pageNum, renderWidth, 'webp');
  if (pdfPageBufferPromiseCache.has(promiseKey)) {
    return pdfPageBufferPromiseCache.get(promiseKey);
  }

  const renderPromise = loadPdfDocument(pdfPath)
    .then(pdf => renderPdfPageFromDocumentToCanvas(pdf, pageNum, renderWidth))
    .then(canvas => canvas.toBuffer('image/webp'))
    .then(buffer => {
      setPdfPageBufferToCache(pdfPath, pageNum, renderWidth, buffer, 'webp');
      pdfPageBufferPromiseCache.delete(promiseKey);
      return buffer;
    })
    .catch(error => {
      pdfPageBufferPromiseCache.delete(promiseKey);
      throw error;
    });

  pdfPageBufferPromiseCache.set(promiseKey, renderPromise);
  return renderPromise;
}

async function renderPdfPageFromDocumentToPngBuffer(pdf, pageNum = 1, targetWidth = 220) {
  const canvas = await renderPdfPageFromDocumentToCanvas(pdf, pageNum, targetWidth);
  return canvas.toBuffer('image/png');
}

async function renderPdfPageFromDocumentToCanvas(pdf, pageNum = 1, targetWidth = 220) {
  const page = await pdf.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const renderWidth = normalizeRenderWidth(targetWidth, Math.max(baseViewport.width, targetWidth));
  const scale = renderWidth / baseViewport.width;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await waitForPdfRender(page.render({ canvasContext: ctx, viewport }));
  return canvas;
}

export function getPdfSpreadCount(totalPages) {
  const safeTotal = Math.max(Number(totalPages) || 0, 0);
  if (safeTotal === 0) return 0;
  if (safeTotal === 1) return 1;
  return 1 + Math.ceil((safeTotal - 1) / 2);
}

export function getPdfSpreadPages(totalPages, spreadNum) {
  const safeTotal = Math.max(Number(totalPages) || 0, 0);
  const safeSpread = Math.max(Number(spreadNum) || 0, 0);
  const spreadCount = getPdfSpreadCount(safeTotal);
  if (!safeSpread || safeSpread > spreadCount) return null;

  if (safeSpread === 1) {
    return {
      spreadNum: 1,
      leftPage: 0,
      rightPage: safeTotal >= 1 ? 1 : 0,
      label: safeTotal >= 1 ? '1' : ''
    };
  }

  const leftPage = (safeSpread - 2) * 2 + 2;
  const rightPage = leftPage + 1 <= safeTotal ? leftPage + 1 : 0;

  return {
    spreadNum: safeSpread,
    leftPage: leftPage <= safeTotal ? leftPage : 0,
    rightPage,
    label: rightPage ? `${leftPage}-${rightPage}` : `${leftPage}`
  };
}

function getSpreadCacheKey(pdfPath, spreadNum, width) {
  return `${pdfPath}:spread:${spreadNum}:${width}`;
}

export function getPdfSpreadFromCache(pdfPath, spreadNum, width) {
  return pdfSpreadCache.get(getSpreadCacheKey(pdfPath, spreadNum, width)) || null;
}

export function setPdfSpreadToCache(pdfPath, spreadNum, width, imageBuffer) {
  pdfSpreadCache.set(getSpreadCacheKey(pdfPath, spreadNum, width), imageBuffer);
}

function getBufferCacheKey(pdfPath, pageNum, width, format = 'png') {
  return `${pdfPath}:buffer:${pageNum}:${width}:${format}`;
}

function getPdfPageBufferFromCache(pdfPath, pageNum, width, format = 'png') {
  return pdfPageBufferCache.get(getBufferCacheKey(pdfPath, pageNum, width, format)) || null;
}

function setPdfPageBufferToCache(pdfPath, pageNum, width, imageBuffer, format = 'png') {
  pdfPageBufferCache.set(getBufferCacheKey(pdfPath, pageNum, width, format), imageBuffer);
}

function getCacheKey(pdfPath, pageNum, width) {
  return `${pdfPath}:${pageNum}:${width}`;
}

export function getPdfPageFromCache(pdfPath, pageNum, width) {
  const key = getCacheKey(pdfPath, pageNum, width);
  return pdfImageCache.get(key) || null;
}

export function setPdfPageToCache(pdfPath, pageNum, width, imageDataUrl) {
  const key = getCacheKey(pdfPath, pageNum, width);
  pdfImageCache.set(key, imageDataUrl);
}

export function clearPdfPageCache() {
  pdfImageCache.clear();
  pdfPageBufferCache.clear();
  pdfPageBufferPromiseCache.clear();
}

function getPdfThumbCacheBaseName(pdfPath) {
  const basename = path.basename(pdfPath, path.extname(pdfPath));
  const normalizedBase = basename
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/[_-]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
  const safeBase = /[a-zA-Z0-9]/.test(normalizedBase) ? normalizedBase : 'pdf';
  const hash = crypto.createHash('sha1').update(path.basename(pdfPath)).digest('hex').slice(0, 12);
  return `${safeBase}-${hash}`;
}

async function removeExistingThumbVariants(baseName) {
  for (const ext of ['png', 'svg']) {
    const filePath = path.join(BOOK_THUMB_CACHE_DIR, `${baseName}.${ext}`);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function ensurePdfBookshelfThumbnail(pdfPath, title) {
  const pdfStat = await fs.stat(pdfPath);
  const baseName = getPdfThumbCacheBaseName(pdfPath);
  const pngPath = path.join(BOOK_THUMB_CACHE_DIR, `${baseName}.png`);
  const svgPath = path.join(BOOK_THUMB_CACHE_DIR, `${baseName}.svg`);
  const version = Math.trunc(pdfStat.mtimeMs);

  await fs.mkdir(BOOK_THUMB_CACHE_DIR, { recursive: true });

  try {
    const cacheStat = await fs.stat(pngPath);
    if (cacheStat.mtimeMs >= pdfStat.mtimeMs) {
      return `/api/book-thumbs/${path.basename(pngPath)}?v=${version}`;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    const cacheStat = await fs.stat(svgPath);
    if (cacheStat.mtimeMs >= pdfStat.mtimeMs) {
      return `/api/book-thumbs/${path.basename(svgPath)}?v=${version}`;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  try {
    const coverBuffer = await renderPdfPageToPngBuffer(pdfPath, 1, 220);
    await removeExistingThumbVariants(baseName);
    await fs.writeFile(pngPath, coverBuffer);
    return `/api/book-thumbs/${path.basename(pngPath)}?v=${version}`;
  } catch (error) {
    console.error(`[ensurePdfBookshelfThumbnail] render failed:`, error.message);
    await removeExistingThumbVariants(baseName);
    await fs.writeFile(svgPath, buildPdfPlaceholderCoverSvg(title), 'utf8');
    return `/api/book-thumbs/${path.basename(svgPath)}?v=${version}`;
  }
}

export async function renderPdfCover(pdfPath, title) {
  try {
    const coverBuffer = await renderPdfPageToPngBuffer(pdfPath, 1, 220);
    return `data:image/png;base64,${coverBuffer.toString('base64')}`;
  } catch (error) {
    console.error(`[renderPdfCover] render failed:`, error.message, error.stack);
    return buildPdfPlaceholderCover(title);
  }
}

export async function readPdfBookMeta(pdfPath, file) {
  const basename = path.basename(String(file));
  const filenameMeta = parsePdfFilename(basename);
  let title = filenameMeta.title;
  let author = filenameMeta.author;

  if (!title || title === 'PDF' || title === basename.replace(/\.[^.]+$/, '')) {
    try {
      const pdf = await loadPdfDocument(pdfPath);
      const metadata = await pdf.getMetadata().catch(() => null);
      title = pickPdfTitle(metadata?.info?.Title || metadata?.metadata?.get?.('dc:title'), title);
      const pdfAuthor = normalizeBookTitle(
        metadata?.info?.Author || metadata?.metadata?.get?.('dc:creator')
      );

    } catch (error) {
      console.warn(`Failed to extract PDF metadata from ${file}:`, error.message);
    }
  }

  title = title || 'PDF';

  let cover = null;
  try {
    cover = await ensurePdfBookshelfThumbnail(pdfPath, title);
  } catch (coverError) {
    console.error(`[readPdfBookMeta] cover render failed:`, coverError.message);
    cover = buildPdfPlaceholderCover(title);
  }

  return { title, author, cover };
}

export function normalizePdfItems(items) {
  const normalizedItems = items
    .map(item => ({
      rawText: item.str || '',
      text: (item.str || '').trim(),
      x: Array.isArray(item.transform) ? item.transform[4] : 0,
      y: Array.isArray(item.transform) ? item.transform[5] : 0,
      width: typeof item.width === 'number' ? item.width : 0,
      hasEOL: !!item.hasEOL
    }))
    .filter(item => item.text || item.rawText);

  normalizedItems.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 2) return b.y - a.y;
    return a.x - b.x;
  });

  const lines = [];
  let currentLine = [];
  let currentY = null;

  function isCjk(char) { return /[\u3400-\u9fff\uf900-\ufaff]/.test(char || ''); }
  function isPunctuation(char) { return /[，。！；：？''（）《》〈〉【】〔〕〖〗…、?.!?;:()[\]{}"'`]/.test(char || ''); }

  function needsSpace(prevItem, nextItem) {
    const prevText = prevItem?.text || '';
    const nextText = nextItem?.text || '';
    if (!prevText || !nextText) return false;
    const prevChar = prevText.slice(-1);
    const nextChar = nextText[0];
    if (isCjk(prevChar) && isCjk(nextChar)) return false;
    if (isPunctuation(prevChar) || isPunctuation(nextChar)) return false;
    const xGap = nextItem.x - (prevItem.x + prevItem.width);
    if (xGap > 3) return true;
    return /[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar);
  }

  function flushLine() {
    if (!currentLine.length) return;
    let line = '';
    currentLine.forEach((item, index) => {
      if (!item.text) return;
      if (line && needsSpace(currentLine[index - 1], item)) line += ' ';
      line += item.text;
    });
    line = line.replace(/\s{2,}/g, ' ').trim();
    if (line) lines.push(line);
    currentLine = [];
  }

  for (const item of normalizedItems) {
    const lineChanged = currentY !== null && Math.abs(item.y - currentY) > 2;
    if (lineChanged && currentLine.length) flushLine();
    currentLine.push(item);
    currentY = item.y;
    if (item.hasEOL) {
      flushLine();
      currentY = null;
    }
  }
  if (currentLine.length) flushLine();

  const cleanLines = lines.map(line => line.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
  const paragraphs = [];
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    paragraphs.push(paragraph.join(' ').replace(/\s{2,}/g, ' ').trim());
    paragraph = [];
  }

  cleanLines.forEach((line, index) => {
    const prevLine = cleanLines[index - 1] || '';
    const nextLine = cleanLines[index + 1] || '';
    const currentIndent = /^\s|^[\u3000]/.test(line);
    const prevEndsSentence = /[銆傦紒锛燂紱.!?鈥︼細:]$/.test(prevLine);
    const nextStartsIndent = /^\s|^[\u3000]/.test(nextLine);
    const shortLine = line.length <= 18;
    paragraph.push(line.trim());
    if (prevEndsSentence || currentIndent || shortLine || nextStartsIndent || !nextLine) flushParagraph();
  });

  flushParagraph();
  return (paragraphs.length ? paragraphs : cleanLines).join('\n\n');
}

export async function extractPdfText(pdfPath, startPage = 1, endPage = null) {
  const pdf = await loadPdfDocument(pdfPath);
  const totalPages = pdf.numPages;
  const actualEndPage = endPage || totalPages;
  const pages = [];

  let coverImage = null;
  if (startPage === 1) {
    try {
      coverImage = await renderPdfPageToImage(pdfPath, 1);
    } catch {}
  }

  for (let i = startPage; i <= Math.min(actualEndPage, totalPages); i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = normalizePdfItems(textContent.items);
    const isScanned = !pageText.trim();
    const htmlContent = pageText
      .split(/\n{2,}/)
      .map(block => block.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean)
      .map(block => `<p>${escHtml(block)}</p>`)
      .join('');
    pages.push({ pageNum: i, content: htmlContent, isScanned });
  }

  return { pages, totalPages, currentPage: startPage, endPage: Math.min(actualEndPage, totalPages), coverImage };
}

export async function renderPdfPageToImage(pdfPath, pageNum, targetWidth = 1600) {

  const cached = getPdfPageFromCache(pdfPath, pageNum, targetWidth);
  if (cached) {
    return cached;
  }
  const coverBuffer = await renderPdfPageToPngBuffer(pdfPath, pageNum, targetWidth);
  const imageDataUrl = `data:image/png;base64,${coverBuffer.toString('base64')}`;
  setPdfPageToCache(pdfPath, pageNum, targetWidth, imageDataUrl);

  return imageDataUrl;
}

export async function renderPdfSpreadToPngBuffer(pdfPath, spreadNum, targetWidth = 2400) {
  const cached = getPdfSpreadFromCache(pdfPath, spreadNum, targetWidth);
  if (cached) {
    return cached;
  }

  const pdf = await loadPdfDocument(pdfPath);
  const spread = getPdfSpreadPages(pdf.numPages, spreadNum);
  if (!spread) {
    return null;
  }

  const spreadWidth = normalizeRenderWidth(targetWidth, targetWidth);
  const singlePageTargetWidth = Math.max(Math.round(spreadWidth / 2), 280);
  const leftBuffer = spread.leftPage
    ? await renderPdfPageFromDocumentToPngBuffer(pdf, spread.leftPage, singlePageTargetWidth)
    : null;
  const rightBuffer = spread.rightPage
    ? await renderPdfPageFromDocumentToPngBuffer(pdf, spread.rightPage, singlePageTargetWidth)
    : null;

  const leftImage = leftBuffer ? await loadImage(leftBuffer) : null;
  const rightImage = rightBuffer ? await loadImage(rightBuffer) : null;

  const pageWidth = Math.max(leftImage?.width || 0, rightImage?.width || singlePageTargetWidth);
  const pageHeight = Math.max(leftImage?.height || 0, rightImage?.height || Math.round(pageWidth * 1.36));
  const canvas = createCanvas(pageWidth * 2, pageHeight);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (leftImage) {
    ctx.drawImage(leftImage, 0, 0, pageWidth, pageHeight);
  }
  if (rightImage) {
    ctx.drawImage(rightImage, pageWidth, 0, pageWidth, pageHeight);
  }

  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(pageWidth - 1, 0, 2, pageHeight);

  const buffer = canvas.toBuffer('image/png');
  setPdfSpreadToCache(pdfPath, spreadNum, targetWidth, buffer);
  return buffer;
}

export async function extractPdfOutline(pdfPath) {
  const pdf = await loadPdfDocument(pdfPath);
  const outline = await pdf.getOutline().catch(() => null);
  if (!Array.isArray(outline) || !outline.length) {
    return { chapters: [], totalChapters: 0, hasRealToc: false };
  }

  const chapters = [];

  async function resolveDestPage(dest) {
    let resolvedDest = dest;
    if (typeof resolvedDest === 'string') {
      resolvedDest = await pdf.getDestination(resolvedDest).catch(() => null);
    }
    if (!Array.isArray(resolvedDest) || !resolvedDest[0]) return 0;
    try {
      const pageIndex = await pdf.getPageIndex(resolvedDest[0]);
      return pageIndex + 1;
    } catch {
      return 0;
    }
  }

  async function walk(items, level = 0) {
    for (const item of items) {
      const label = String(item?.title || '').replace(/\s+/g, ' ').trim();
      const targetPage = await resolveDestPage(item?.dest);
      if (label && targetPage > 0) {
        chapters.push({
          id: `pdf-${chapters.length + 1}`,
          label,
          href: '',
          fragment: '',
          playOrder: chapters.length + 1,
          level,
          targetPage,
          sourcePage: targetPage
        });
      }
      if (Array.isArray(item?.items) && item.items.length) {
        await walk(item.items, level + 1);
      }
    }
  }

  await walk(outline);
  return {
    chapters,
    totalChapters: chapters.length,
    hasRealToc: chapters.length > 0
  };
}
