export function escHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function normalizeBookTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/\.[^.]+$/, '')
    .replace(/\s*\((?:z-library|1lib|z-lib)[^)]*\)\s*$/i, '')
    .replace(/\s*[.。…]+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function pickPdfTitle(metadataTitle, fallbackTitle) {
  const normalizedMetadataTitle = normalizeBookTitle(metadataTitle);
  if (normalizedMetadataTitle && normalizedMetadataTitle.length >= 2) {
    return normalizedMetadataTitle;
  }
  return normalizeBookTitle(fallbackTitle) || 'PDF';
}

export function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} filename - PDF 文件名
 * @returns {{title: string, author: string}}
 */
export function parsePdfFilename(filename) {
  const basename = String(filename).replace(/\.[^.]+$/, '');

  let match = basename.match(/^(.+)_([^_]+)$/);
  if (match) {
    const title = normalizeBookTitle(match[1]);
    const author = normalizeBookTitle(match[2]);
    if (title && title.length >= 2) return { title, author };
  }

  match = basename.match(/^\[(.+)\](.+)$/);
  if (match) {
    const author = normalizeBookTitle(match[1]);
    const title = normalizeBookTitle(match[2]);
    if (title && title.length >= 2) return { title, author };
  }

  match = basename.match(/^(.+?)\s*-\s*(.+)$/);
  if (match) {
    const title = normalizeBookTitle(match[1]);
    const author = normalizeBookTitle(match[2]);
    if (title && title.length >= 2) return { title, author };
  }

  match = basename.match(/^([^-]+)-(.+)$/);
  if (match) {
    const author = normalizeBookTitle(match[1]);
    const title = normalizeBookTitle(match[2]);
    if (title && title.length >= 2) return { title, author };
  }

  match = basename.match(/^(.+?)[\(（](.+?)[\)）]$/);
  if (match) {
    const title = normalizeBookTitle(match[1]);
    const author = normalizeBookTitle(match[2]);
    if (title && title.length >= 2) return { title, author };
  }
  return {
    title: normalizeBookTitle(basename) || 'PDF',
  };
}