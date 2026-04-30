/** useBookReader Composable - Main Entry Point */
import { ref, onMounted, provide, inject } from 'vue'
import axios from 'axios'
import {
  PAGE_FONT_SIZE, PAGE_LINE_HEIGHT, PAGE_PAD_TOP, PAGE_PAD_BOTTOM,
  PAGE_PAD_H, PAGE_NUM_H, PAGE_SAFETY, DESIGN_BASE_HEIGHT, MIN_PAGE_SCALE,
  log, logWarn, computePageScale, applyPageScaleToCSS, enc, delay, isChrome,
  escHtml, escAttr
} from '../constants.js'
import { createCacheKey, readCache, writeCache } from '../requestCache.js'
import { createState, createPrivateState } from './state.js'
import {
  requestBooks, requestBookMeta, requestChapterData
} from './api.js'
import {
  fetchPdfPageList, getPdfPageUrl, buildPdfImagePageHtml, preloadPdfPages
} from './pdf.js'
import {
  isSinglePageLayout, calculatePageSize, splitContentToPages,
  extractBlocks, isTocLikeContent, hasDirectText, splitLargeBlock,
  cleanHtml, fixImagePaths
} from './pagination.js'
import {
  extractPageBodyHtml, mountHtmlPage, buildCoverHtml, addPage, renderPage
} from './rendering.js'
import {
  isScannedPdfContent, getPageThemePalette, getCloseAnimationThreshold,
  getInitialPreloadCount, estimateChapterRenderedPages, shouldPersistChapter
} from './utils.js'

const $ = window.$ || window.jQuery
const API_BASE = import.meta.env.VITE_API_BASE || ''
const API = API_BASE + '/api'
const APK_WARMUP_DELAY = 1200
const APK_WARMUP_BATCH_PAUSE = 80
const IS_ANDROID_DEVICE = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const LOAD_AHEAD_THRESHOLD = 4
const MAX_PERSISTED_BOOK_PAGES = 200
const PDF_PAGE_URLS_TTL = 1000 * 60 * 60 * 24 * 7

// State Management
export function useBookReader() {
  const state = createState()
  const privateState = createPrivateState()

  const {
    scene, transitioning, openingBook, closingBook, books, loading, error,
    currentBook, totalPages, displayTotalPages, currentPage, pageLoading,
    tocList, tocVisible,
    viewport, magazine,
    pageMap, pageCache, chapterPageMap
  } = state

  const {
    _pageW, _pageH, _apiTotalChapters, _chaptersLoaded, _loadingChapter,
    _loadScheduled, _turning, _needsPageUpdate, _abortController,
    _loadTimeout, _initialWarmupTimer, _preparedFile, _preparingFile,
    _preparePromise, _bookType, _$magazine, _libraryWarmupScheduled,
    _libraryWarmupRunning, _booksRefreshTimer, _booksRefreshInFlight,
    _persistedBookPageBudget, _pdfPageListPromises, _preloadController,
    _loadedTocFile
  } = privateState

  // turn.js Instance Management
  function setMagazineInstance($mag) { _$magazine = $mag }
  function clearMagazineInstance() { _$magazine = null }

  // Background Preloading
  function startBackgroundPreload() {
    stopBackgroundPreload()
    _preloadController = new AbortController()
    backgroundPreloadLoop(_preloadController.signal).catch(e => {
      if (e.name !== 'AbortError') {
        console.warn('[preload] Background preload error:', e)
      }
    })
  }
  
  function stopBackgroundPreload() {
    if (_preloadController) {
      _preloadController.abort()
      _preloadController = null
    }
  }
  
  async function backgroundPreloadLoop(signal) {
    log('[preload] Starting async background preload, currently loaded:', _chaptersLoaded, '/', _apiTotalChapters)
    
    while (_chaptersLoaded < _apiTotalChapters && !signal.aborted) {
      if (_chaptersLoaded >= _apiTotalChapters) break
      if (_loadingChapter) {
        await delay(100)
        continue
      }
      const chapterNum = _chaptersLoaded + 1
      log('[preload] loading chapter', chapterNum)
      await loadNextChapter()
      if (!signal.aborted && _chaptersLoaded < _apiTotalChapters) {
        await delay(50)
      }
    }
    log('[preload] Background preload completed, loaded chapters:', _chaptersLoaded, '/', _apiTotalChapters)
  }

  function scheduleLoad() {
    if (_loadScheduled || _loadingChapter || _chaptersLoaded >= _apiTotalChapters) return
    const remainingAhead = totalPages.value - currentPage.value
    if (remainingAhead > LOAD_AHEAD_THRESHOLD) return
    _loadScheduled = true
    _loadTimeout = setTimeout(async () => {
      _loadScheduled = false
      _loadTimeout = null
      if (_abortController?.signal?.aborted || _loadingChapter || _chaptersLoaded >= _apiTotalChapters) return
      const nextRemainingAhead = totalPages.value - currentPage.value
      if (nextRemainingAhead > LOAD_AHEAD_THRESHOLD) return
      await loadNextChapter()
    }, 80)
  }

  function scheduleInitialWarmup(preloadCount = 0) {
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
      await loadNextChapter()

      if (_abortController?.signal?.aborted || remaining <= 0) return
      _initialWarmupTimer = setTimeout(pump, 0)
    }

    _initialWarmupTimer = setTimeout(pump, 0)
  }

  // Table of Contents Loading
  async function loadToc(bookFile) {
    if (!bookFile) return
    if (_loadedTocFile === bookFile && tocList.value.length > 0) return
    _loadedTocFile = bookFile
    try {
      const response = await fetch('/toc.json')
      if (!response.ok) {
        console.warn('[TOC] 加载目录文件失败:', response.status)
        return
      }
      const rawItems = await response.json()
      if (!Array.isArray(rawItems)) {
        console.warn('[TOC] 目录数据格式错误')
        return
      }
      tocList.value = rawItems.map(item => ({
        label: item.title || item.label || '',
        title: item.title || item.title || '',
        targetPage: Number(item.page) || Number(item.targetPage) || 0
      }))
    } catch (err) {
      console.warn('[TOC] 加载目录失败:', err)
    }
  }

  function updateTocPageMapping(chapterNum, chapterId, chapterHref, startTurnPage, endTurnPage) {
    if (!chapterHref) return

    if (chapterId) {
      chapterPageMap.set(chapterId, { startPage: startTurnPage, endPage: endTurnPage })
    }

    if (!tocList.value.length) return

    for (const item of tocList.value) {
      if (item.targetPage && item.targetPage > 0) continue

      const itemHref = (item.href || item.targetChapterHref || '').split('#')[0]
      const cleanChapterHref = chapterHref.split('#')[0]
      const isMatch =
        itemHref === cleanChapterHref ||
        cleanChapterHref.endsWith(itemHref) ||
        cleanChapterHref.includes(itemHref) ||
        itemHref.replace(/^(OEBPS\/|Text\/|EPUB\/|Content\/)/i, '') ===
          cleanChapterHref.replace(/^(OEBPS\/|Text\/|EPUB\/|Content\/)/i, '')

      if (isMatch) {
        item.targetPage = startTurnPage
        item._loaded = true
      }
    }
  }

  async function jumpToTocItem(item, flipToPageFn) {
    if (!item) return

    const targetPage = item.targetPage
    if (!targetPage || targetPage < 1) return

    tocVisible.value = false

    if (typeof flipToPageFn === 'function') {
      await flipToPageFn(targetPage)
    } else {
      currentPage.value = targetPage
    }

    await fastLoadToTurnPage(targetPage)

    if (typeof flipToPageFn === 'function') {
      await flipToPageFn(targetPage)
    }
  }

  function toggleToc() { tocVisible.value = !tocVisible.value }

  // Fast load to specified page
  function fastLoadToTurnPage(targetTurnPage) {
    if (_chaptersLoaded >= _apiTotalChapters) return Promise.resolve()
    const BUFFER = LOAD_AHEAD_THRESHOLD + 2

    return (async () => {
      while (_chaptersLoaded < _apiTotalChapters && totalPages.value < targetTurnPage + BUFFER) {
        if (_loadingChapter) {
          await delay(30)
          continue
        }
        if (_abortController?.signal?.aborted) return
        await loadNextChapter()
      }
    })().catch(e => {
      if (e.name !== 'AbortError') {
        console.warn('[fastLoad] error:', e)
      }
    })
  }

  // Chapter Loading
  async function loadNextChapter() {
    if (_loadingChapter || _chaptersLoaded >= _apiTotalChapters) return
    if (_abortController?.signal?.aborted || !currentBook.value?.file) return

    _loadingChapter = true
    pageLoading.value = true
    const chapterNum = _chaptersLoaded + 1
    const fileName = currentBook.value?.file || ''

    try {
      let data = pageCache.get(chapterNum)
      if (!data) {
        data = await requestChapterData(fileName, chapterNum, {
          signal: _abortController?.signal
        })
        if (!data) {
          _chaptersLoaded = chapterNum
          _loadingChapter = false
          pageLoading.value = false
          if (_chaptersLoaded >= _apiTotalChapters) {
            displayTotalPages.value = totalPages.value
          }
          return
        }
        if (data) {
          pageCache.set(chapterNum, data)
        }
      }

      if (_abortController?.signal?.aborted) return

      const isScannedPdf = data?.type === 'pdf' && (data?.isScanned || !data?.content?.trim())
      
      if (data?.content?.trim()) {
        const chunks = splitContentToPages(data.content, data.type, _pageW, _pageH)
        const startTurnPage = totalPages.value + 1

        chunks.forEach(html => {
          const turnPage = totalPages.value + 1
          pageMap.set(turnPage, html)
          totalPages.value = turnPage
        })

        const endTurnPage = totalPages.value
        
        if (data.chapterHref || data.chapterId) {
          updateTocPageMapping(chapterNum, data.chapterId, data.chapterHref, startTurnPage, endTurnPage)
        }
      } else if (isScannedPdf) {
        let pageImageUrl = data?.pageImageUrl || ''
        if (!pageImageUrl) {
          pageImageUrl = await getPdfPageUrl(fileName, chapterNum, _pdfPageListPromises)
          if (pageImageUrl) {
            data.pageImageUrl = pageImageUrl
            pageCache.set(chapterNum, data)
          }
        }
        if (pageImageUrl) {
          const turnPage = totalPages.value + 1
          pageMap.set(turnPage, buildPdfImagePageHtml(pageImageUrl, chapterNum))
          totalPages.value = turnPage
        }
      }

      _chaptersLoaded = chapterNum
    } catch (e) {
      if (e.name !== 'AbortError' && !axios.isCancel(e)) {
        console.error(`[chapter] failed to load ${chapterNum}`, e)
      }
      _chaptersLoaded = chapterNum
    } finally {
      _loadingChapter = false
      pageLoading.value = false
      if (_chaptersLoaded >= _apiTotalChapters) {
        displayTotalPages.value = totalPages.value
      }
    }
  }

  // Window Resize Reflow
  function reflowPages() {
    if (!currentBook.value?.file || _chaptersLoaded === 0) return

    const pageSize = calculatePageSize()
    _pageW = pageSize.pageW
    _pageH = pageSize.pageH
    const previousPage = currentPage.value

    pageMap.clear()
    totalPages.value = 0

    for (let ch = 1; ch <= _chaptersLoaded; ch++) {
      const data = pageCache.get(ch)
      const isScannedPdf = data?.type === 'pdf' && (data?.isScanned || !data?.content?.trim())

      if (isScannedPdf) {
        if (!data?.pageImageUrl) continue
        const turnPage = totalPages.value + 1
        pageMap.set(turnPage, buildPdfImagePageHtml(data.pageImageUrl, ch))
        totalPages.value = turnPage
        continue
      }

      if (!data?.content?.trim()) continue

      const chunks = splitContentToPages(data.content, data.type, _pageW, _pageH)
      const startTurnPage = totalPages.value + 1

      chunks.forEach(html => {
        const turnPage = totalPages.value + 1
        pageMap.set(turnPage, html)
        totalPages.value = turnPage
      })

      const endTurnPage = totalPages.value
      if (data.chapterHref || data.chapterId) {
        updateTocPageMapping(ch, data.chapterId, data.chapterHref, startTurnPage, endTurnPage)
      }
    }

    if (_chaptersLoaded >= _apiTotalChapters) {
      displayTotalPages.value = totalPages.value
    }

    return { previousPage, newTotal: totalPages.value }
  }

  // Lifecycle Hooks
  onMounted(() => {
    applyPageScaleToCSS(computePageScale())

    function fixViewportHeight() {
      const vh = window.visualViewport ? window.visualViewport.height * 0.01 : window.innerHeight * 0.01
      document.documentElement.style.setProperty('--vh', `${vh}px`)
      applyPageScaleToCSS(computePageScale())
    }
    fixViewportHeight()
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fixViewportHeight)
      window.visualViewport.addEventListener('scroll', fixViewportHeight)
    }
    window.addEventListener('resize', fixViewportHeight)
  })

  // Exports
  return {
    scene, transitioning, openingBook, closingBook, books, loading, error,
    currentBook, totalPages, displayTotalPages, currentPage, pageLoading,
    tocList, tocVisible,
    viewport, magazine,
    pageMap, pageCache, chapterPageMap,
    fetchBooks, prepareBook, ensureBookPrepared,
    loadToc, toggleToc, jumpToTocItem,
    getAbortController, abortAllRequests, resetBookState, scheduleLoad,
    loadNextChapter, splitContentToPages, addPage, renderPage, mountHtmlPage,
    buildCoverHtml, getInitialPreloadCount,
    calculatePageSize, enc, delay, isChrome, computePageScale, applyPageScaleToCSS,
    get _pageW() { return _pageW }, set _pageW(v) { _pageW = v },
    get _pageH() { return _pageH }, set _pageH(v) { _pageH = v },
    get _apiTotalChapters() { return _apiTotalChapters }, set _apiTotalChapters(v) { _apiTotalChapters = v },
    get _chaptersLoaded() { return _chaptersLoaded }, set _chaptersLoaded(v) { _chaptersLoaded = v },
    get _loadingChapter() { return _loadingChapter }, set _loadingChapter(v) { _loadingChapter = v },
    get _turning() { return _turning }, set _turning(v) { _turning = v },
    get _needsPageUpdate() { return _needsPageUpdate }, set _needsPageUpdate(v) { _needsPageUpdate = v },
    get _preparedFile() { return _preparedFile }, set _preparedFile(v) { _preparedFile = v },
    get _bookType() { return _bookType }, set _bookType(v) { _bookType = v },
    setMagazineInstance, clearMagazineInstance,
    startBackgroundPreload, stopBackgroundPreload, reflowPages
  }
}

// Provide/Inject Key
export { delay } from '../constants.js'

export const READER_STATE_KEY = 'readerState'

export function provideReaderState() {
  const state = useBookReader()
  provide(READER_STATE_KEY, state)
  return state
}

export function injectReaderState() {
  return inject(READER_STATE_KEY)
}
