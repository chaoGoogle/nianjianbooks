/**
 * Book State and Request Management
 * Handles book preparation, state reset, and request lifecycle
 */

import { delay } from '../constants.js'
import { calculatePageSize } from './pageLayout.js'
import { fetchPdfPageList, getPdfPageUrl } from './pdfManager.js'
import { splitContentToPages } from './pagination.js'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const API = API_BASE + '/api'
const APK_WARMUP_DELAY = 1200
const APK_WARMUP_BATCH_PAUSE = 80
const IS_ANDROID_DEVICE = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const LOAD_AHEAD_THRESHOLD = 4
const MAX_PERSISTED_BOOK_PAGES = 200

export function createBookStateManager() {
  const pageMap = new Map()
  const pageCache = new Map()
  const chapterPageMap = new Map()
  const _persistedBookPageBudget = new Map()

  let _pageW = 0
  let _pageH = 0
  let _apiTotalChapters = 0
  let _chaptersLoaded = 0
  let _loadingChapter = false
  let _loadScheduled = false
  let _turning = false
  let _needsPageUpdate = false
  let _abortController = null
  let _loadTimeout = null
  let _initialWarmupTimer = null
  let _preparedFile = ''
  let _preparingFile = ''
  let _preparePromise = null
  let _bookType = ''
  let _$magazine = null
  let _preloadController = null

  function setMagazineInstance($mag) { _$magazine = $mag }
  function clearMagazineInstance() { _$magazine = null }

  function getAbortController() {
    if (_abortController) _abortController.abort()
    _abortController = new AbortController()
    return _abortController
  }

  function abortAllRequests() {
    if (_abortController) {
      _abortController.abort()
      _abortController = null
    }
    if (_loadTimeout) {
      clearTimeout(_loadTimeout)
      _loadTimeout = null
    }
    if (_initialWarmupTimer) {
      clearTimeout(_initialWarmupTimer)
      _initialWarmupTimer = null
    }
    stopBackgroundPreload()
    _loadingChapter = false
    _loadScheduled = false
  }

  function resetBookState() {
    stopBackgroundPreload()
    abortAllRequests()
    pageMap.clear()
    _pageW = 0
    _pageH = 0
    _apiTotalChapters = 0
    _chaptersLoaded = 0
    _loadingChapter = false
    _loadScheduled = false
    _turning = false
    _needsPageUpdate = false
    _bookType = ''
    _preparedFile = ''
    _preparingFile = ''
    _preparePromise = null
    _$magazine = null
  }

  function getPersistedPageBudget(fileName) {
    if (!_persistedBookPageBudget.has(fileName)) {
      _persistedBookPageBudget.set(fileName, {
        pages: 0,
        chapters: new Set()
      })
    }
    return _persistedBookPageBudget.get(fileName)
  }

  function estimateChapterRenderedPages(data) {
    if (!data) return 0
    if (data.type === 'pdf') return 1
    if (!data.content?.trim()) return 1
    const pageW = _pageW || calculatePageSize().pageW
    const pageH = _pageH || calculatePageSize().pageH
    try {
      return Math.max(splitContentToPages(data.content, data.type, pageW, pageH).length, 1)
    } catch (_) {
      return 1
    }
  }

  function shouldPersistChapter(fileName, chapterNum, data) {
    if (!fileName || !chapterNum || !data) return false
    const budget = getPersistedPageBudget(fileName)
    if (budget.chapters.has(chapterNum)) return true

    const chapterPages = estimateChapterRenderedPages(data)
    if (budget.pages + chapterPages > MAX_PERSISTED_BOOK_PAGES) {
      return false
    }

    budget.pages += chapterPages
    budget.chapters.add(chapterNum)
    return true
  }

  function startBackgroundPreload() {
    stopBackgroundPreload()
    _preloadController = new AbortController()
    return _preloadController.signal
  }

  function stopBackgroundPreload() {
    if (_preloadController) {
      _preloadController.abort()
      _preloadController = null
    }
  }

  function scheduleLoad(loadNextChapterFn, totalPagesValue, currentPageValue) {
    if (_loadScheduled || _loadingChapter || _chaptersLoaded >= _apiTotalChapters) return
    const remainingAhead = totalPagesValue - currentPageValue
    if (remainingAhead > LOAD_AHEAD_THRESHOLD) return
    _loadScheduled = true
    _loadTimeout = setTimeout(async () => {
      _loadScheduled = false
      _loadTimeout = null
      if (_abortController?.signal?.aborted || _loadingChapter || _chaptersLoaded >= _apiTotalChapters) return
      const nextRemainingAhead = totalPagesValue - currentPageValue
      if (nextRemainingAhead > LOAD_AHEAD_THRESHOLD) return
      await loadNextChapterFn()
    }, 80)
  }

  function scheduleInitialWarmup(preloadCount = 0, loadNextChapterFn) {
    if (preloadCount <= 0) return
    if (_initialWarmupTimer) {
      clearTimeout(_initialWarmupTimer)
      _initialWarmupTimer = null
    }

    let remaining = preloadCount
    const pump = async () => {
      _initialWarmupTimer = null
      if (_abortController?.signal?.aborted || remaining <= 0) return
      if (_loadingChapter || _chaptersLoaded >= _apiTotalChapters) return

      remaining -= 1
      await loadNextChapterFn()

      if (_abortController?.signal?.aborted || remaining <= 0) return
      _initialWarmupTimer = setTimeout(pump, 0)
    }

    _initialWarmupTimer = setTimeout(pump, 0)
  }

  function getInitialPreloadCount(book) {
    if (!book) return 10
    const isPdf = book.file?.toLowerCase?.().endsWith('.pdf') || book.type === 'pdf'
    if (IS_ANDROID_DEVICE) return isPdf ? 1 : 2
    return isPdf ? 1 : 2
  }

  function buildPdfImagePageHtml(imageUrl, pdfPageNum) {
    return '<div class="scanned-page" data-pdf-page="' + pdfPageNum + '"><img src="' + imageUrl + '" alt="" /></div>'
  }

  function isScannedPdfContent(html) {
    return html?.includes('class="scanned-page"') || html?.includes('class=\'scanned-page\'')
  }

  function extractPageBodyHtml(html) {
    const doc = String(html || '')
    if (!/<html[\s>]/i.test(doc)) return doc

    const parsed = new DOMParser().parseFromString(doc, 'text/html')
    parsed.querySelectorAll('script, style, link, meta, title').forEach(node => node.remove())
    return parsed.body?.innerHTML || ''
  }

  function getPageThemePalette() {
    return {
      bodyColor: '#1e1a14',
      linkColor: '#2a5aa0',
      headingColor: '#1a1208',
      pageBg: '#f8f2e6'
    }
  }

  function fixImagePaths(html, currentBook) {
    if (!currentBook) return html
    return html.replace(
      /(<(?:img|image)[^>]+?(?:src|xlink:href)=["'])([^"']+)(["'])/gi,
      (match, prefix, src, suffix) => {
        if (src.startsWith('http') || src.startsWith('data:')) return match
        return `${prefix}${API}/file/image?file=${encodeURIComponent(currentBook.file)}&path=${encodeURIComponent(src)}${suffix}`
      }
    )
  }

  return {
    pageMap,
    pageCache,
    chapterPageMap,
    get _pageW() { return _pageW },
    set _pageW(v) { _pageW = v },
    get _pageH() { return _pageH },
    set _pageH(v) { _pageH = v },
    get _apiTotalChapters() { return _apiTotalChapters },
    set _apiTotalChapters(v) { _apiTotalChapters = v },
    get _chaptersLoaded() { return _chaptersLoaded },
    set _chaptersLoaded(v) { _chaptersLoaded = v },
    get _loadingChapter() { return _loadingChapter },
    set _loadingChapter(v) { _loadingChapter = v },
    get _turning() { return _turning },
    set _turning(v) { _turning = v },
    get _needsPageUpdate() { return _needsPageUpdate },
    set _needsPageUpdate(v) { _needsPageUpdate = v },
    get _preparedFile() { return _preparedFile },
    set _preparedFile(v) { _preparedFile = v },
    get _bookType() { return _bookType },
    set _bookType(v) { _bookType = v },
    setMagazineInstance,
    clearMagazineInstance,
    getAbortController,
    abortAllRequests,
    resetBookState,
    getPersistedPageBudget,
    shouldPersistChapter,
    startBackgroundPreload,
    stopBackgroundPreload,
    scheduleLoad,
    scheduleInitialWarmup,
    getInitialPreloadCount,
    buildPdfImagePageHtml,
    isScannedPdfContent,
    extractPageBodyHtml,
    getPageThemePalette,
    fixImagePaths,
    fetchPdfPageList,
    getPdfPageUrl
  }
}
