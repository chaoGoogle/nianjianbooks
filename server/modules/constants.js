import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BOOKS_DIR = path.join(__dirname, '../public/books');
export const BOOK_THUMB_CACHE_DIR = path.join(__dirname, '../public/cache/bookshelf');
export const PDF_PAGE_CACHE_DIR = path.join(__dirname, '../public/cache/pdf-pages');
export const PDF_SPREADS_DIR = path.join(__dirname, '../public/spreads');
export const PORT = 8088;

export const ALLOWED_EXTENSIONS = ['.pdf'];

export function validateInt(val, min = 1, max = Infinity, defaultVal = 1) {
  const num = parseInt(val, 10);
  if (Number.isNaN(num)) return defaultVal;
  return Math.min(Math.max(num, min), max);
}

export function validateFileExt(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ALLOWED_EXTENSIONS.includes(ext);
}

export function sanitizeError(error) {
  if (process.env.NODE_ENV === 'development') {
    return error?.message || String(error);
  }
  return undefined;
}