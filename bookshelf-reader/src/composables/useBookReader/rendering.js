/** useBookReader - Page Rendering Functions */
import $ from 'jquery'
import { isScannedPdfContent } from './utils.js'

export function extractPageBodyHtml(html) {
  const doc = String(html || '')
  if (!/<html[\s>]/i.test(doc)) return doc

  const parsed = new DOMParser().parseFromString(doc, 'text/html')
  parsed.querySelectorAll('script, style, link, meta, title').forEach(node => node.remove())
  return parsed.body?.innerHTML || ''
}

export function mountHtmlPage($target, html, pageNum, pageW, pageH) {
  if (!$target?.length) return
  $target.empty()
  if (pageW && pageH) {
    $target.css({ width: pageW, height: pageH })
  }
  const isScanned = isScannedPdfContent(html)
  const $gradient = $('<div class="gradient"></div>')
  const $frame = $('<div class="page-frame"></div>')
  const $content = $('<div class="page-content"></div>')
  if (isScanned) {
    $content.addClass('is-scanned-pdf')
  }
  $content.html(extractPageBodyHtml(html))
  $frame.append($content)
  $target.append($gradient, $frame, $('<div class="page-num">' + (pageNum - 1) + '</div>'))
}

export function buildCoverHtml(currentBook) {
  const book = currentBook || {}
  const $cover = $('<div class="cover-page"/>')
  if (book.cover) {
    $cover.append($('<img/>').attr({ src: book.cover, alt: book.title }))
  }
  return $('<div/>').append($cover).html()
}

export function addPage(pageNum, $book, pageW, pageH, pageMap, buildCoverHtmlFn, _chaptersLoaded, _apiTotalChapters) {
  if (!$book?.turn?.('is')) return

  try {
    if ($book.turn('hasPage', pageNum)) {
      const bookData = $book.data()
      const $pageEl = $(bookData?.pageObjs?.[pageNum])
      if (pageNum === 1) {
        $pageEl?.html(buildCoverHtmlFn())
      } else if (pageMap.has(pageNum)) {
        const content = pageMap.get(pageNum)
        mountHtmlPage($pageEl, content, pageNum, pageW, pageH)
      }
      return
    }

    const $el = $('<div/>').css({ width: pageW, height: pageH })
    if ($book.turn('addPage', $el, pageNum)) {
      if (pageNum === 1) {
        $el.html(buildCoverHtmlFn())
      } else if (pageMap.has(pageNum)) {
        const content = pageMap.get(pageNum)
        mountHtmlPage($el, content, pageNum, pageW, pageH)
      } else if (_chaptersLoaded >= _apiTotalChapters) {
        $el.html(`<div class="gradient"></div><div class="page-content page-end">完</div>`)
      } else {
        $el.html(`<div class="gradient"></div><div class="page-loader"><div class="loading-spinner small"></div></div>`)
      }
    }
  } catch (e) {
    console.warn(`[page] failed to add page ${pageNum}`, e)
  }
}

export async function renderPage(pageNum, $el, $book, pageMap, loadNextChapterFn, _chaptersLoaded, _apiTotalChapters, _abortController, _loadingChapter, delay, buildCoverHtmlFn, mountHtmlPageFn) {
  if (!$book?.turn?.('is')) return

  if (pageNum === 1) {
    $el.html(buildCoverHtmlFn())
    return
  }

  if (pageMap.has(pageNum)) {
    mountHtmlPageFn($el, pageMap.get(pageNum), pageNum)
    return
  }

  if (_chaptersLoaded >= _apiTotalChapters) {
    $el.html(`<div class="gradient"></div><div class="page-content page-end">完</div>`)
    return
  }

  $el.html(`<div class="gradient"></div><div class="page-loader"><div class="loading-spinner small"></div></div>`)

  let waited = 0
  const maxWait = 10000
  while (!pageMap.has(pageNum) && waited < maxWait) {
    if (!$book?.turn?.('is') || _abortController?.signal?.aborted) return
    if (!_loadingChapter && _chaptersLoaded < _apiTotalChapters) {
      await loadNextChapterFn()
    }
    await delay(150)
    waited += 150
  }

  if (!$book?.turn?.('is')) return

  if (pageMap.has(pageNum)) {
    mountHtmlPageFn($el, pageMap.get(pageNum), pageNum)
  } else {
    $el.html(`<div class="gradient"></div><div class="page-content">内容加载超时，请尝试刷新页面</div>`)
  }
}
