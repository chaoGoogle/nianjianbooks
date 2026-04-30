/** useBookReader - Utility Functions */

export function isScannedPdfContent(html) {
  return html?.includes('class="scanned-page"') || html?.includes('class=\'scanned-page\'')
}

export function getPageThemePalette() {
  return {
    bodyColor: '#1e1a14',
    linkColor: '#2a5aa0',
    headingColor: '#1a1208',
    pageBg: '#f8f2e6'
  }
}

export function getCloseAnimationThreshold() {
  return 8
}

export function getInitialPreloadCount(book, IS_ANDROID_DEVICE) {
  if (!book) return 10
  const isPdf = book.file?.toLowerCase?.().endsWith('.pdf') || book.type === 'pdf'
  if (IS_ANDROID_DEVICE) return isPdf ? 1 : 2
  return isPdf ? 1 : 2
}

export function estimateChapterRenderedPages(data, _pageW, _pageH, splitContentToPagesFn) {
  if (!data) return 0
  if (data.type === 'pdf') return 1
  if (!data.content?.trim()) return 1
  const pageW = _pageW || 400
  const pageH = _pageH || 600
  try {
    return Math.max(splitContentToPagesFn(data.content, data.type, pageW, pageH).length, 1)
  } catch (_) {
    return 1
  }
}

export function shouldPersistChapter(fileName, chapterNum, data, _persistedBookPageBudget, MAX_PERSISTED_BOOK_PAGES, estimateChapterRenderedPagesFn, _pageW, _pageH, splitContentToPagesFn) {
  if (!fileName || !chapterNum || !data) return false
  if (!_persistedBookPageBudget.has(fileName)) {
    _persistedBookPageBudget.set(fileName, {
      pages: 0,
      chapters: new Set()
    })
  }
  const budget = _persistedBookPageBudget.get(fileName)
  if (budget.chapters.has(chapterNum)) return true

  const chapterPages = estimateChapterRenderedPagesFn(data, _pageW, _pageH, splitContentToPagesFn)
  if (budget.pages + chapterPages > MAX_PERSISTED_BOOK_PAGES) {
    return false
  }

  budget.pages += chapterPages
  budget.chapters.add(chapterNum)
  return true
}
