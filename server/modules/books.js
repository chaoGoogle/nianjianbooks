import path from 'path';
import fs from 'fs/promises';
import { BOOKS_DIR } from './constants.js';
import { normalizeBookTitle } from './utils.js';
import { readPdfBookMeta } from './pdf.js';

export async function ensureBooksDir() {
  try {
    await fs.access(BOOKS_DIR);
  } catch {
    await fs.mkdir(BOOKS_DIR, { recursive: true });
    console.log(`Created books directory: ${BOOKS_DIR}`);
  }
}

export async function scanBooks() {
  try {
    await ensureBooksDir();
    const files = await fs.readdir(BOOKS_DIR);
    const books = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.pdf') continue;

      const filePath = path.join(BOOKS_DIR, file);
      const pdfMeta = await readPdfBookMeta(filePath, file);

      books.push({
        file,
        title: normalizeBookTitle(pdfMeta.title) || pdfMeta.title,
        author: pdfMeta.author,
        type: 'pdf',
        cover: pdfMeta.cover
      });
    }

    books.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return books;
  } catch (error) {
    console.error('Error scanning books:', error);
    return [];
  }
}

export async function scanBooksProgressive({ onProgress } = {}) {
  try {
    await ensureBooksDir();
    const files = await fs.readdir(BOOKS_DIR);
    const pdfFiles = files.filter(file => path.extname(file).toLowerCase() === '.pdf');
    const books = [];

    for (let index = 0; index < pdfFiles.length; index += 1) {
      const file = pdfFiles[index];
      const filePath = path.join(BOOKS_DIR, file);
      const pdfMeta = await readPdfBookMeta(filePath, file);

      books.push({
        file,
        title: normalizeBookTitle(pdfMeta.title) || pdfMeta.title,
        author: pdfMeta.author,
        type: 'pdf',
        cover: pdfMeta.cover
      });

      books.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
      if (typeof onProgress === 'function') {
        onProgress({
          books: [...books],
          total: pdfFiles.length,
          processed: index + 1
        });
      }
    }

    return books;
  } catch (error) {
    console.error('Error scanning books progressively:', error);
    return [];
  }
}