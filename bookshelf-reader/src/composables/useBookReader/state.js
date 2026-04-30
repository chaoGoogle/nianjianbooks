/** useBookReader State Management */
import { ref } from 'vue'

export function createState() {
  // UI State
  const scene = ref('desk')
  const transitioning = ref(false)
  const openingBook = ref('')
  const closingBook = ref('')
  const books = ref([])
  const loading = ref(true)
  const error = ref('')

  // Book Reading State
  const currentBook = ref(null)
  const totalPages = ref(0)
  const displayTotalPages = ref(0)
  const currentPage = ref(1)
  const pageLoading = ref(false)

  // Table of Contents State
  const tocList = ref([])
  const tocVisible = ref(false)

  // DOM References
  const viewport = ref(null)
  const magazine = ref(null)

  // Data Storage
  const pageMap = new Map()
  const pageCache = new Map()
  const chapterPageMap = new Map()

  return {
    scene, transitioning, openingBook, closingBook, books, loading, error,
    currentBook, totalPages, displayTotalPages, currentPage, pageLoading,
    tocList, tocVisible,
    viewport, magazine,
    pageMap, pageCache, chapterPageMap
  }
}

export function createPrivateState() {
  // Page dimensions
  let _pageW = 0
  let _pageH = 0
  
  // Chapter tracking
  let _apiTotalChapters = 0
  let _chaptersLoaded = 0
  let _loadingChapter = false
  let _loadScheduled = false
  let _turning = false
  let _needsPageUpdate = false
  
  // Request management
  let _abortController = null
  let _loadTimeout = null
  let _initialWarmupTimer = null
  
  // Book preparation
  let _preparedFile = ''
  let _preparingFile = ''
  let _preparePromise = null
  let _bookType = ''
  
  // turn.js instance
  let _$magazine = null
  
  // Library warmup
  let _libraryWarmupScheduled = false
  let _libraryWarmupRunning = false
  let _booksRefreshTimer = null
  let _booksRefreshInFlight = false
  
  // Persisted book page budget
  const _persistedBookPageBudget = new Map()
  
  // PDF page list promises
  const _pdfPageListPromises = new Map()
  
  // Preload controller
  let _preloadController = null
  
  // Loaded TOC file
  let _loadedTocFile = ''

  return {
    get _pageW() { return _pageW }, set _pageW(v) { _pageW = v },
    get _pageH() { return _pageH }, set _pageH(v) { _pageH = v },
    get _apiTotalChapters() { return _apiTotalChapters }, set _apiTotalChapters(v) { _apiTotalChapters = v },
    get _chaptersLoaded() { return _chaptersLoaded }, set _chaptersLoaded(v) { _chaptersLoaded = v },
    get _loadingChapter() { return _loadingChapter }, set _loadingChapter(v) { _loadingChapter = v },
    get _loadScheduled() { return _loadScheduled }, set _loadScheduled(v) { _loadScheduled = v },
    get _turning() { return _turning }, set _turning(v) { _turning = v },
    get _needsPageUpdate() { return _needsPageUpdate }, set _needsPageUpdate(v) { _needsPageUpdate = v },
    get _abortController() { return _abortController }, set _abortController(v) { _abortController = v },
    get _loadTimeout() { return _loadTimeout }, set _loadTimeout(v) { _loadTimeout = v },
    get _initialWarmupTimer() { return _initialWarmupTimer }, set _initialWarmupTimer(v) { _initialWarmupTimer = v },
    get _preparedFile() { return _preparedFile }, set _preparedFile(v) { _preparedFile = v },
    get _preparingFile() { return _preparingFile }, set _preparingFile(v) { _preparingFile = v },
    get _preparePromise() { return _preparePromise }, set _preparePromise(v) { _preparePromise = v },
    get _bookType() { return _bookType }, set _bookType(v) { _bookType = v },
    get _$magazine() { return _$magazine }, set _$magazine(v) { _$magazine = v },
    get _libraryWarmupScheduled() { return _libraryWarmupScheduled }, set _libraryWarmupScheduled(v) { _libraryWarmupScheduled = v },
    get _libraryWarmupRunning() { return _libraryWarmupRunning }, set _libraryWarmupRunning(v) { _libraryWarmupRunning = v },
    get _booksRefreshTimer() { return _booksRefreshTimer }, set _booksRefreshTimer(v) { _booksRefreshTimer = v },
    get _booksRefreshInFlight() { return _booksRefreshInFlight }, set _booksRefreshInFlight(v) { _booksRefreshInFlight = v },
    _persistedBookPageBudget,
    _pdfPageListPromises,
    get _preloadController() { return _preloadController }, set _preloadController(v) { _preloadController = v },
    get _loadedTocFile() { return _loadedTocFile }, set _loadedTocFile(v) { _loadedTocFile = v }
  }
}
