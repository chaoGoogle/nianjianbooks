/** useBookReader Composable - Main Entry Point */
import { ref, onMounted, provide, inject } from 'vue'
import axios from 'axios'
import {
  PAGE_FONT_SIZE, PAGE_LINE_HEIGHT, PAGE_PAD_TOP, PAGE_PAD_BOTTOM,
  PAGE_PAD_H, PAGE_NUM_H, PAGE_SAFETY, DESIGN_BASE_HEIGHT, MIN_PAGE_SCALE,
  log, logWarn, computePageScale, applyPageScaleToCSS, enc, delay, isChrome
} from './constants.js'
import { createCacheKey, readCache, writeCache } from './requestCache.js'
import {
  buildCoverHtml as _buildCoverHtml,
  mountHtmlPage as _mountHtmlPage,
  addPage as _addPage,
  renderPage as _renderPage
} from './modules/rendering.js'
import {
  scheduleLibraryWarmup as _scheduleLibraryWarmup,
  warmLibraryCache as _warmLibraryCache,
  scheduleBooksRefresh as _scheduleBooksRefresh
} from './modules/libraryWarmup.js'
import {
  extractBlocks,
  isTocLikeContent,
  hasDirectText,
  splitLargeBlock,
  cleanHtml
} from './modules/pagination.js'

const $ = window.$ || window.jQuery
const API = '/nianjian/api'
const IS_ANDROID_DEVICE = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const LOAD_AHEAD_THRESHOLD = 4
const PDF_PAGE_URLS_TTL = 1000 * 60 * 60 * 24 * 7

function resolveApiAssetUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (/^(data:|blob:|https?:\/\/)/i.test(url)) return url
  if (url.startsWith('/api/')) return `/nianjian${url}`
  return url
}

// State Management
export function useBookReader() {
  const scene = ref('desk')
  const transitioning = ref(false)
  const openingBook = ref('')
  const closingBook = ref('')
  const books = ref([])
  const loading = ref(true)
  const error = ref('')

  const currentBook = ref(null)
  const totalPages = ref(0)
  const displayTotalPages = ref(0)
  const currentPage = ref(1)
  const pageLoading = ref(false)

  const tocList = ref([])
  const tocVisible = ref(false)

  const viewport = ref(null)
  const magazine = ref(null)

  const pageMap = new Map()
  const pageCache = new Map()
  const chapterPageMap = new Map()

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
  let _libraryWarmupScheduled = false
  let _libraryWarmupRunning = false
  let _booksRefreshTimer = null
  let _booksRefreshInFlight = false
  const _pdfPageListPromises = new Map()

  function getPdfPageListCacheKey(fileName) {
    return createCacheKey('pdf-page-urls', fileName)
  }

  async function fetchPdfPageList(fileName, { forceRefresh = false } = {}) {
    if (!fileName) {
      return { urls: [], pageCount: 0, sourcePages: 0, version: '' }
    }

    const cacheKey = getPdfPageListCacheKey(fileName)
    if (!forceRefresh) {
      const cached = await readCache(cacheKey, PDF_PAGE_URLS_TTL)
      if (cached?.urls?.length) {
        return cached
      }

      if (_pdfPageListPromises.has(fileName)) {
        return _pdfPageListPromises.get(fileName)
      }
    }

    const request = fetch(`${API}/process?pdfPath=${enc(fileName)}`)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch spread URLs for ${fileName}`)
        }

        const payload = await response.json()
        if (!payload.success) {
          throw new Error(payload.message || `Failed to process ${fileName}`)
        }

        const data = {
          urls: Array.isArray(payload.data?.urls)
            ? payload.data.urls.map(resolveApiAssetUrl).filter(Boolean)
            : [],
          pageCount: Number(payload.data?.pageCount) || 0,
          sourcePages: Number(payload.data?.sourcePages) || 0,
          version: payload.data?.version || ''
        }

        await writeCache(cacheKey, data, PDF_PAGE_URLS_TTL)
        return data
      })
      .finally(() => {
        _pdfPageListPromises.delete(fileName)
      })

    _pdfPageListPromises.set(fileName, request)
    return request
  }

  async function getPdfPageUrl(fileName, pageNum) {
    if (!fileName || !pageNum) return ''
    const data = await fetchPdfPageList(fileName)
    return data.urls?.[pageNum - 1] || ''
  }
  // turn.js Instance Management
  function setMagazineInstance($mag) { _$magazine = $mag }
  function clearMagazineInstance() { _$magazine = null }

  function resetBookState() {
    stopBackgroundPreload()
    abortAllRequests()
    pageMap.clear()
    totalPages.value = 0
    displayTotalPages.value = 0
    currentPage.value = 1
    pageLoading.value = false
    tocList.value = []
    tocVisible.value = false
    _loadedTocFile = ''
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

  function clearBooksRefreshTimer() {
    if (_booksRefreshTimer) {
      clearTimeout(_booksRefreshTimer)
      _booksRefreshTimer = null
    }
  }

  // [moved to modules/bookState.js] getInitialPreloadCount (parameterized version)

  // [moved to modules/bookState.js] getPersistedPageBudget, estimateChapterRenderedPages, shouldPersistChapter

  // Background Preloading
  let _preloadController = null
  
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

  // [moved to modules/pageLayout.js] getCloseAnimationThreshold

  function isSinglePageLayout() {
    if (typeof window === 'undefined') return true
    const narrowScreen = window.innerWidth <= 900
    const coarsePointer = typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false
    return narrowScreen || coarsePointer
  }

  // Page Size Calculation
  function calculatePageSize() {
    const singlePage = isSinglePageLayout()
    const horizontalPadding = singlePage ? Math.max(window.innerWidth * 0.04, 12) : 50
    const topOffset = singlePage ? 92 : 130
    const bottomOffset = singlePage ? 132 : 64
    const vpH = Math.max(window.innerHeight - topOffset - bottomOffset, 320)
    const vpW = Math.max(window.innerWidth - horizontalPadding * 2, 220)
    const isWide = !singlePage && window.innerWidth > window.innerHeight
    const ratio = isWide ? (2482 * 2) / 3368 : 2482 / 3368

    let height = vpH
    let width = ratio * height
    if (width > vpW) {
      width = vpW
      height = width / ratio
    }

    width = Math.floor(width / 2) * 2
    height = Math.floor(height)

    return {
      pageW: isWide ? width / 2 : width,
      pageH: height,
      bookW: width,
      bookH: height,
      isWide,
      isSinglePage: singlePage
    }
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

  // API Calls
  async function requestBooks({ forceRefresh = false } = {}) {
    const response = await axios.get(`${API}/books`, {
      params: forceRefresh ? { refresh: 1 } : undefined
    })
    const payload = response.data
    if (!payload.success) {
      throw new Error('Failed to load books')
    }
    return {
      books: payload.data || [],
      complete: !!payload.complete,
      loading: !!payload.loading,
      progress: payload.progress || { processed: 0, total: 0 }
    }
  }

  async function requestBookMeta(fileName) {
    const response = await axios.get(`${API}/file/pages?file=${enc(fileName)}`)
    const payload = response.data
    if (!payload.success) {
      throw new Error('Failed to load book metadata')
    }
    return payload.data
  }

  function scheduleBooksRefresh(delayMs = 800) {
    const stateFlags = {
      get booksRefreshTimer() { return _booksRefreshTimer },
      set booksRefreshTimer(v) { _booksRefreshTimer = v }
    }
    _scheduleBooksRefresh(stateFlags, fetchBooks, delayMs)
  }

  async function fetchBooks({ silent = false, forceRefresh = false } = {}) {
    if (_booksRefreshInFlight) return
    if (!silent) loading.value = true
    error.value = ''
    _booksRefreshInFlight = true
    try {
      const payload = await requestBooks({ forceRefresh })
      books.value = payload.books
      scheduleLibraryWarmup()
      if (!payload.complete && payload.loading) {
        scheduleBooksRefresh()
      } else {
        clearBooksRefreshTimer()
      }
    } catch (err) {
      if (axios.isCancel(err)) return
      error.value = '后端服务异常，无法加载书籍列表'
    } finally {
      _booksRefreshInFlight = false
      if (!silent) loading.value = false
    }
  }

  async function fetchBookByName(name) {
    try {
      const response = await axios.get(`${API}/books/by-name/${encodeURIComponent(name)}`)
      const payload = response.data
      if (!payload.success || !payload.data) {
        return null
      }
      return {
        ...payload.data,
        cover: resolveApiAssetUrl(payload.data.cover)
      }
    } catch (err) {
      if (err.response?.status === 404) {
        return null
      }
      console.warn('获取书籍失败:', err)
      return null
    }
  }

  function getInitialPreloadCount() {
    return 1
  }

  let _loadedTocFile = ''
  async function loadToc(bookFile) {
    console.log('[loadToc] called with bookFile:', bookFile, 'current _loadedTocFile:', _loadedTocFile)
    if (!bookFile) return
    if (_loadedTocFile === bookFile && tocList.value.length > 0) {
      console.log('[loadToc] skip — already loaded for', bookFile)
      return
    }
    _loadedTocFile = bookFile

    const bookName = String(bookFile || '').replace(/\.pdf$/i, '')

    if (bookName === '2024') {
      tocList.value = [
        { label: '2023年亮点', targetPage: 5 },
        { label: '荣誉榜', targetPage: 11 },
        { label: '工作概述', targetPage: 15 },
        { label: '公共服务', targetPage: 21 },
        { label: '一、开放服务', targetPage: 23 },
        { label: '二、陈列展览', targetPage: 31 },
        { label: '三、社会教育', targetPage: 43 },
        { label: '四、宣传推广', targetPage: 85 },
        { label: '五、数字化建设', targetPage: 105 },
        { label: '六、文化创意', targetPage: 111 },
        { label: '科学研究', targetPage: 125 },
        { label: '七、文物鉴定审核', targetPage: 127 },
        { label: '八、藏品征集管理', targetPage: 131 },
        { label: '九、文物保护修复', targetPage: 143 },
        { label: '十、学术与出版', targetPage: 151 },
        { label: '综合管理', targetPage: 167 },
        { label: '十一、党群建设', targetPage: 169 },
        { label: '十二、组织管理', targetPage: 185 },
        { label: '十三、安全保卫', targetPage: 195 },
        { label: '大事记', targetPage: 198 }
      ]
    } else if (bookName === '2025') {
      tocList.value = [
        { label: '工作概述', targetPage: 7 },
        { label: '大事记', targetPage: 13 },
        { label: '公共服务', targetPage: 19 },
        { label: '一、开放服务', targetPage: 20 },
        { label: '二、陈列展览', targetPage: 25 },
        { label: '三、社会教育', targetPage: 43 },
        { label: '四、宣传推广', targetPage: 98 },
        { label: '五、数字化建设', targetPage: 128 },
        { label: '六、文化创意', targetPage: 131 },
        { label: '科学研究', targetPage: 141 },
        { label: '七、文物鉴定审核', targetPage: 142 },
        { label: '八、藏品征集管理', targetPage: 144 },
        { label: '九、文物保护修复', targetPage: 159 },
        { label: '十、学术与出版', targetPage: 175 },
        { label: '综合管理', targetPage: 181 },
        { label: '十一、党群建设', targetPage: 182 },
        { label: '十二、组织管理', targetPage: 191 },
        { label: '十三、安全保卫', targetPage: 197 },
        { label: '附录', targetPage: 199 },
        { label: '2024年亮点', targetPage: 202 },
        { label: '荣誉榜', targetPage: 204 }
      ]
    } else {
      tocList.value = []
    }
  }

  async function fetchBookMeta(fileName) {
    const metaData = await requestBookMeta(fileName)
    _apiTotalChapters = metaData.totalPages || 0
    _bookType = metaData.type || ''
    return metaData
  }

  async function prepareBook(book) {
    if (!book?.file) return

    if (_preparedFile === book.file && _apiTotalChapters > 0 && totalPages.value > 0) {
      currentBook.value = book
      return
    }

    if (_preparePromise && _preparingFile === book.file) {
      return _preparePromise
    }

    _preparingFile = book.file
    _preparePromise = (async () => {
      currentBook.value = book
      resetBookState()
      currentBook.value = book
      const pageSize = calculatePageSize()
      _pageW = pageSize.pageW
      _pageH = pageSize.pageH
      getAbortController()

      await fetchBookMeta(book.file)
      await loadToc(book.file)

      if (book.type === 'pdf') {
        fetchPdfPageList(book.file)
          .then(pageData => {
            const pdfCover = pageData.urls?.[0] || ''
            if (!pdfCover || currentBook.value?.file !== book.file) return
            book.cover = pdfCover
            currentBook.value = { ...book, cover: pdfCover }
          })
          .catch(e => {
            console.warn('PDF cover URL fetch failed:', e)
          })
      }
      _preparedFile = book.file
      scheduleInitialWarmup(getInitialPreloadCount(book))
      startBackgroundPreload()

      if (!IS_ANDROID_DEVICE && book.type === 'pdf' && _apiTotalChapters > 0) {
        setTimeout(() => {
          preloadPdfPages(book.file, _apiTotalChapters)
        }, 2000)
      }

    })().finally(() => {
      _preparePromise = null
      _preparingFile = ''
    })

    return _preparePromise
  }

  async function preloadPdfPages(fileName, totalPages) {
    if (!fileName?.toLowerCase()?.endsWith('.pdf')) return
    if (!totalPages || totalPages <= 0) return

    const pageList = await fetchPdfPageList(fileName)
    const preloadLimit = Math.min(10, totalPages, pageList.urls.length)
    log('[preloadPdfPages] start', fileName, preloadLimit)

    for (let i = 0; i < preloadLimit; i++) {
      const url = pageList.urls[i]
      if (!url) continue
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await delay(100)
    }

    log('[preloadPdfPages] completed')
  }

  function buildPdfImagePageHtml(imageUrl, pdfPageNum) {
    return '<div class="scanned-page" data-pdf-page="' + pdfPageNum + '"><img src="' + imageUrl + '" alt="" /></div>'
  }

  async function ensureBookPrepared(book, options) {
    if (!book?.file) return
    if (_preparedFile === book.file && _apiTotalChapters > 0) return
    await prepareBook(book, options)
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

    // Jump to target page first (show loading animation if content not loaded)
    if (typeof flipToPageFn === 'function') {
      await flipToPageFn(targetPage)
    } else {
      currentPage.value = targetPage
    }

    // Load content near target page
    await fastLoadToTurnPage(targetPage)

    // Content loaded, jump again to trigger refresh
    if (typeof flipToPageFn === 'function') {
      await flipToPageFn(targetPage)
    }
  }

// Fast load to specified page (skip delays), return Promise when target page content is ready
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
  function toggleToc() { tocVisible.value = !tocVisible.value }

  function scheduleLibraryWarmup() {
    const stateFlags = {
      get libraryWarmupScheduled() { return _libraryWarmupScheduled },
      set libraryWarmupScheduled(v) { _libraryWarmupScheduled = v },
      get libraryWarmupRunning() { return _libraryWarmupRunning },
      set libraryWarmupRunning(v) { _libraryWarmupRunning = v }
    }
    _scheduleLibraryWarmup(stateFlags, books, () => warmLibraryCache())
  }

  async function warmLibraryCache() {
    const stateFlags = {
      get libraryWarmupRunning() { return _libraryWarmupRunning },
      set libraryWarmupRunning(v) { _libraryWarmupRunning = v }
    }
    await _warmLibraryCache(stateFlags, books)
  }

  // [moved to modules/bookState.js] getPageThemePalette (duplicated in modules)

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

  // Chapter Loading
  async function loadNextChapter() {
    if (_loadingChapter || _chaptersLoaded >= _apiTotalChapters) return
    if (_abortController?.signal?.aborted || !currentBook.value?.file) return

    _loadingChapter = true
    pageLoading.value = true
    const chapterNum = _chaptersLoaded + 1
    const fileName = currentBook.value?.file || ''

    try {
      if (_abortController?.signal?.aborted) return

      const pageImageUrl = await getPdfPageUrl(fileName, chapterNum)
      if (pageImageUrl) {
        const turnPage = totalPages.value + 1
        pageMap.set(turnPage, buildPdfImagePageHtml(pageImageUrl, chapterNum))
        totalPages.value = turnPage
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

  // Content Pagination
  function splitContentToPages(rawHtml, type, pageW, pageH) {
    const width = pageW || Math.max(window.innerWidth > window.innerHeight ? 420 : 340, 320)
    const height = pageH || Math.max(window.innerHeight - 180, 480)

    const scale = computePageScale()
    const scaledFontSize = PAGE_FONT_SIZE * scale
    const scaledPadTop = PAGE_PAD_TOP * scale
    const scaledPadBottom = PAGE_PAD_BOTTOM * scale
    const scaledPadH = PAGE_PAD_H * scale
    const scaledNumH = PAGE_NUM_H * scale
    const scaledSafety = Math.max(PAGE_SAFETY * scale, 12)

    const $probe = $('<div/>').css({
      position: 'absolute',
      top: '-99999px',
      left: '-99999px',
      width: `${width}px`,
      height: `${height}px`,
      overflow: 'hidden',
      visibility: 'hidden'
    })
    const $probeContent = $('<div class="page-content"/>')
    $probe.append($probeContent)
    $('body').append($probe)
    const contentInnerH = $probeContent[0].clientHeight || height
    $probe.remove()

    const usableH = Math.max(contentInnerH - scaledPadTop - scaledPadBottom - scaledNumH - scaledSafety, 60)
    const usableW = width - scaledPadH
    if (usableH <= 0 || usableW <= 0) return [rawHtml]

    let html = cleanHtml(rawHtml, type)
    if (!html.trim()) return []

    html = fixImagePaths(html)

    const $ruler = $('<div/>').css({
      position: 'absolute',
      top: '-99999px',
      left: '-99999px',
      width: `${usableW}px`,
      fontSize: `${scaledFontSize}px`,
      lineHeight: PAGE_LINE_HEIGHT,
      fontFamily: "'PingFang SC','Microsoft YaHei','Noto Serif SC',serif",
      wordBreak: 'break-all',
      overflow: 'visible',
      visibility: 'hidden'
    })
    $('body').append($ruler)

    const blocks = extractBlocks(html)
    log('[splitContentToPages] extractBlocks returned block count:', blocks.length)
    
    const pages = []
    let bucket = []
    let bucketH = 0

    function flush() {
      if (!bucket.length) return
      const $wrapper = $('<div/>')
      bucket.forEach($node => $wrapper.append($node.clone()))
      pages.push($wrapper.html())
      bucket = []
      bucketH = 0
    }

    blocks.forEach($block => {
      const text = $block.text().replace(/[\s\u3000\u00a0]/g, '')
      if (!text && !$block.find('img').length) return

      $ruler.empty().append($block.clone())
      const blockHeight = $ruler[0].scrollHeight

      if (blockHeight >= usableH) {
        flush()
        splitLargeBlock($block, usableH, $ruler).forEach(subHtml => {
          pages.push(subHtml)
        })
        return
      }

      if (bucketH + blockHeight > usableH) flush()
      bucket.push($block)
      bucketH += blockHeight
    })

    flush()
    $ruler.remove()

    return pages.length ? pages : [html]
  }

  // [extractBlocks, isTocLikeContent, hasDirectText, splitLargeBlock, cleanHtml imported from modules/pagination.js]

  function fixImagePaths(html) {
    if (!currentBook.value) return html
    return html.replace(
      /(<(?:img|image)[^>]+?(?:src|xlink:href)=["'])([^"']+)(["'])/gi,
      (match, prefix, src, suffix) => {
        if (src.startsWith('http') || src.startsWith('data:')) return match
        return `${prefix}${API}/file/image?file=${enc(currentBook.value.file)}&path=${enc(src)}${suffix}`
      }
    )
  }

  function mountHtmlPage($target, html, pageNum, pageW, pageH) {
    _mountHtmlPage($target, html, pageNum, pageW, pageH, isScannedPdfContent, extractPageBodyHtml)
  }

  function addPage(pageNum, $book, pageW, pageH) {
    const buildFn = () => buildCoverHtml()
    const mountFn = ($t, html, pN, pW, pH) => mountHtmlPage($t, html, pN, pW, pH)
    _addPage(pageNum, $book, pageW, pageH, pageMap, _chaptersLoaded, _apiTotalChapters, buildFn, mountFn)
  }

  async function renderPage(pageNum, $el, $book) {
    const buildFn = () => buildCoverHtml()
    const mountFn = ($t, html, pN) => mountHtmlPage($t, html, pN)
    await _renderPage(pageNum, $el, $book, pageMap, _chaptersLoaded, _apiTotalChapters, _abortController, _loadingChapter, buildFn, mountFn, loadNextChapter, delay)
  }

  function buildCoverHtml() {
    return _buildCoverHtml(currentBook)
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

  // Window Resize Reflow
  function reflowPages() {
    if (!currentBook.value?.file || _chaptersLoaded === 0) return

    const previousPage = currentPage.value

    if (_chaptersLoaded >= _apiTotalChapters) {
      displayTotalPages.value = totalPages.value
    }

    return { previousPage, newTotal: totalPages.value }
  }

  // Exports
  return {
    scene, transitioning, openingBook, closingBook, books, loading, error,
    currentBook, totalPages, displayTotalPages, currentPage, pageLoading,
    tocList, tocVisible,
    viewport, magazine,
    pageMap, pageCache, chapterPageMap,
    fetchBooks, fetchBookByName, prepareBook, ensureBookPrepared,
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
export { delay } from './constants.js'

export const READER_STATE_KEY = 'readerState'

export function provideReaderState() {
  const state = useBookReader()
  provide(READER_STATE_KEY, state)
  return state
}

export function injectReaderState() {
  return inject(READER_STATE_KEY)
}