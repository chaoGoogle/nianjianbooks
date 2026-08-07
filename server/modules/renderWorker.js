import path from 'path';
import { pathToFileURL } from 'url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

GlobalWorkerOptions.workerSrc = pathToFileURL(
  path.join(import.meta.dir, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

const MAX_WORKER_DOC_CACHE = 1;
const pdfDocs = new Map();

async function destroyDoc(doc) {
  try {
    await doc?.destroy?.();
  } catch {}
}

function evictOldestDoc() {
  const firstKey = pdfDocs.keys().next().value;
  if (firstKey === undefined) return;
  const doc = pdfDocs.get(firstKey);
  pdfDocs.delete(firstKey);
  destroyDoc(doc);
}

async function getPdfDocument(pdfPath) {
  if (pdfDocs.has(pdfPath)) {
    const doc = pdfDocs.get(pdfPath);
    pdfDocs.delete(pdfPath);
    pdfDocs.set(pdfPath, doc);
    return doc;
  }

  while (pdfDocs.size >= MAX_WORKER_DOC_CACHE) {
    evictOldestDoc();
  }

  const fileBuffer = await Bun.file(pdfPath).arrayBuffer();
  const doc = await getDocument({
    data: new Uint8Array(fileBuffer),
    disableWorker: true
  }).promise;

  pdfDocs.set(pdfPath, doc);
  return doc;
}

function normalizeRenderWidth(targetWidth) {
  const preferredWidth = Number.isFinite(targetWidth) && targetWidth > 0 ? targetWidth : 2400;
  return Math.min(Math.max(Math.round(preferredWidth), 280), 3200);
}

self.onmessage = async (e) => {
  const { id, pdfPath, pageNum, width, purge } = e.data;

  if (purge) {
    while (pdfDocs.size > 0) {
      evictOldestDoc();
    }
    if (typeof Bun !== 'undefined' && typeof Bun.gc === 'function') {
      Bun.gc(true);
    }
    self.postMessage({ id, ok: true, purged: true, rss: process.memoryUsage().rss });
    return;
  }

  try {
    const pdf = await getPdfDocument(pdfPath);
    const renderWidth = normalizeRenderWidth(width);
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: renderWidth / baseViewport.width });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const buffer = canvas.toBuffer('image/webp');
    page.cleanup();
    self.postMessage({ id, ok: true, buffer, rss: process.memoryUsage().rss }, [buffer.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
