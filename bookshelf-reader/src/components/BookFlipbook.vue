<template>
  <div class="flipbook-wrapper">
    <div class="magazine-viewport" ref="viewportEl">
      <div class="container">
        <div class="magazine" ref="magazineEl"></div>
      </div>
    </div>

    <!-- PC 端初始加载遮罩：等待前 3 页内容就绪 -->
    <div v-if="initialLoading" class="initial-loading-overlay">
      <div class="loading-spinner"></div>
      <p>正在准备内容…</p>
    </div>

    <button class="nav-btn prev-btn" type="button" @click="prevPage" v-show="currentPage > 1">&#10094;</button>
    <button class="nav-btn next-btn" type="button" @click="nextPage" v-show="currentPage < totalPages">&#10095;</button>

    <!-- 移动端专用翻页按钮：相对书本距离固定，不贴屏幕底部 -->
    <div class="mobile-nav-controls">
      <button
        type="button"
        class="mobile-nav-btn"
        :disabled="currentPage <= 1"
        @click.stop="prevPage"
      >
        上一页
      </button>
      <button
        type="button"
        class="mobile-nav-btn"
        :disabled="currentPage >= totalPages"
        @click.stop="nextPage"
      >
        下一页
      </button>
    </div>

    <div
      v-if="previewImageSrc"
      class="image-preview"
      @click="closeImagePreview"
    >
      <button
        class="image-preview__close"
        type="button"
        aria-label="关闭图片预览"
        @click.stop="closeImagePreview"
      >
        ×
      </button>
      <img
        class="image-preview__img"
        :src="previewImageSrc"
        alt=""
        @click.stop
      />
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted, inject, toRaw } from 'vue'

const props = defineProps({
  currentBook: {
    type: Object,
    default: () => ({})
  },
  totalPages: {
    type: Number,
    required: true
  },
  displayTotalPages: {
    type: Number,
    required: true
  },
  currentPage: {
    type: Number,
    required: true
  }
})

const emit = defineEmits(['page-changed', 'initialized'])

const viewportEl = ref(null)
const magazineEl = ref(null)
const previewImageSrc = ref('')
const initialLoading = ref(false)

const $ = window.$ || window.jQuery
const readerState = inject('readerState')

if (!readerState) {
  console.error('BookFlipbook: readerState not found')
}

const {
  pageMap,
  pageCache,
  chapterPageMap,
  ensureBookPrepared,
  abortAllRequests,
  scheduleLoad,
  loadNextChapter,
  addPage,
  buildCoverHtml,
  mountHtmlPage,
  delay,
  isChrome,
  reflowPages: readerReflowPages,
  computePageScale,
  applyPageScaleToCSS
} = readerState

let _turning = false
let $magazine = null
let _pageMapWatcher = null
let _tx = 0
let _ty = 0
let _lastPageMapSize = 0
let _resizeTimer = null
let _handleViewportResize = null
let _viewportTouchCapture = null
const IS_ANDROID_DEVICE = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
const TURN_PAGE_BUFFER = 4
const DEFAULT_CORNER_SIZE = 100
const ANDROID_CORNER_TOUCH_MIN = 18
const ANDROID_CORNER_TOUCH_MAX = 30
const MOBILE_CORNER_TOUCH_MIN = 24
const MOBILE_CORNER_TOUCH_MAX = 40
const PROGRAMMATIC_TURN_CORNERS = 'bl,br'

function isAndroidAdaptiveMode() {
  if (typeof window === 'undefined') return false
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
  return coarsePointer && isAndroid && window.innerWidth <= 900
}

function getTurnCornerSize() {
  if (typeof window === 'undefined') return DEFAULT_CORNER_SIZE

  const viewportWidth = window.innerWidth || 0
  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches
    : false
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

  if (isAndroid && coarsePointer) {
    return Math.max(ANDROID_CORNER_TOUCH_MIN, Math.min(ANDROID_CORNER_TOUCH_MAX, Math.round(viewportWidth * 0.052)))
  }

  if (coarsePointer || viewportWidth <= 900) {
    return Math.max(MOBILE_CORNER_TOUCH_MIN, Math.min(MOBILE_CORNER_TOUCH_MAX, Math.round(viewportWidth * 0.07)))
  }

  return DEFAULT_CORNER_SIZE
}

function openImagePreview(event) {
  event.preventDefault()
  event.stopPropagation()

  const src = event.currentTarget?.getAttribute('src')
  if (!src) return
  previewImageSrc.value = src
}

function closeImagePreview() {
  previewImageSrc.value = ''
}

function shouldAllowAndroidCornerTouch(target, clientX, clientY) {
  if (!isAndroidAdaptiveMode()) return true

  const pageEl = target?.closest?.('.page')
  if (!pageEl) return true

  const rect = pageEl.getBoundingClientRect()
  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const inBounds = localX >= 0 && localY >= 0 && localX <= rect.width && localY <= rect.height

  if (!inBounds) return true

  const inBottomHalf = localY >= rect.height * 0.5
  return inBottomHalf
}

function handleAndroidViewportTouchStart(event) {
  if (!isAndroidAdaptiveMode() || previewImageSrc.value) return

  const touch = event.touches?.[0]
  if (!touch) return

  if (shouldAllowAndroidCornerTouch(event.target, touch.clientX, touch.clientY)) {
    return
  }

  // 检查是否到达边界，禁止角标翻页
  const currentPage = $magazine?.turn('page')
  const totalPages = $magazine?.turn('pages')
  if (currentPage >= totalPages) {
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }

  event.stopImmediatePropagation()
}

function getBufferedPageCapacity(minimumPage = 0) {
  const knownPages = pageMap.size > 0 ? Math.max(...pageMap.keys()) : 2
  // 如果已加载完所有内容，不再预加载
  const futureBuffer = (readerState._chaptersLoaded < readerState._apiTotalChapters && knownPages < readerState.totalPages.value) ? TURN_PAGE_BUFFER : 0
  return Math.max(2, knownPages + futureBuffer, minimumPage)
}

function ensureTurnPageCapacity($book, minimumPage = 0) {
  if (!$book?.turn?.('is')) return
  const targetPages = getBufferedPageCapacity(minimumPage)
  const currentPages = $book.turn('pages')
  if (targetPages > currentPages) {
    $book.turn('pages', targetPages)
  }
}

function refreshRenderedPages($mag, pageW, pageH) {
  if (!$mag?.turn?.('is')) return
  const bookData = $mag.data()
  const pageObjs = bookData?.pageObjs || {}

  Object.keys(pageObjs).forEach(key => {
    const pageNum = Number(key)
    if (!pageNum) return

    try {
      const $pageEl = $(pageObjs[pageNum])
      if (!$pageEl?.length) return

      $pageEl.css({ width: pageW, height: pageH })

      if (pageNum === 1) {
        $pageEl.html(buildCoverHtml())
        return
      }

      if (readerState.pageMap.has(pageNum)) {
        const content = readerState.pageMap.get(pageNum)
        mountHtmlPage($pageEl, content, pageNum, pageW, pageH)
      }
    } catch (e) {
      console.warn('[refreshRenderedPages] failed:', pageNum, e)
    }
  })
}

async function waitForChapterAndRender(pageNum, $book) {
  const maxWait = 15000
  const checkInterval = 100
  let waited = 0
  
  if (!readerState._loadingChapter && readerState._chaptersLoaded < readerState._apiTotalChapters) {
    readerState.loadNextChapter().catch(e => {
      console.warn('触发章节加载失败:', e)
    })
  }
  
  while (!pageMap.has(pageNum) && waited < maxWait) {
    if (!$magazine?.turn?.('is') || readerState._abortController?.signal?.aborted) return
    await readerState.delay(checkInterval)
    waited += checkInterval
    if (readerState._chaptersLoaded >= readerState._apiTotalChapters) break
  }
  
  if (pageMap.has(pageNum)) {
    try {
      if (!$book.turn('hasPage', pageNum)) return
      const bookData = $book.data()
      const $pageEl = $(bookData?.pageObjs?.[pageNum])
      if ($pageEl?.length) {
        mountHtmlPage($pageEl, pageMap.get(pageNum), pageNum, readerState._pageW, readerState._pageH)
      }
    } catch (e) {
      console.warn('渲染页面失败:', e)
    }
  }
}

function watchPageMapChanges() {
  const currentSize = pageMap.size
  if (currentSize <= _lastPageMapSize || !$magazine?.turn?.('is')) return

  _lastPageMapSize = currentSize
  ensureTurnPageCapacity($magazine)
  pageMap.forEach((html, pageNum) => {
    try {
      if (!$magazine.turn('hasPage', pageNum)) return
      const bookData = $magazine.data()
      const $pageEl = $(bookData?.pageObjs?.[pageNum])
      if ($pageEl.find('.page-loader').length > 0) {
        mountHtmlPage($pageEl, html, pageNum, readerState._pageW, readerState._pageH)
      }
    } catch (e) {
      console.warn('Failed to refresh page content:', e)
    }
  })
}

async function waitForInitialVisualReady(pageNums, maxWait = 12000) {
  const targetPages = Array.isArray(pageNums) ? pageNums : [pageNums]
  if (!targetPages.length) return false

  const checkInterval = 80
  let waited = 0

  const allReady = () => targetPages.every(p => pageMap.has(p))

  while (waited < maxWait) {
    if (!$magazine?.turn?.('is')) return false
    if (allReady()) return true
    // 所有章节已加载完毕但目标页仍未就绪，说明内容不足，停止等待
    if (readerState._chaptersLoaded >= readerState._apiTotalChapters && readerState._apiTotalChapters > 0) {
      return false
    }
    await delay(checkInterval)
    waited += checkInterval
  }

  return false
}

async function initFlipbook() {
  if (!props.currentBook?.file) {
    console.error('BookFlipbook: currentBook invalid', props.currentBook)
    return
  }

  destroyTurnInstance()

  const pageSize = readerState.calculatePageSize()
  const isWide = pageSize.isWide
  const w = pageSize.bookW
  const h = pageSize.bookH
  readerState._pageW = pageSize.pageW
  readerState._pageH = pageSize.pageH

  const rawMagazineEl = toRaw(magazineEl.value)
  const rawViewportEl = toRaw(viewportEl.value)
  const $mag = $(rawMagazineEl)
  const $vp = $(rawViewportEl)
  $magazine = $mag

  $vp.css({ width: window.innerWidth, height: window.innerHeight })
  $mag.css({ width: w, height: h })

  const initialPages = getBufferedPageCapacity()
  const turnCornerSize = getTurnCornerSize()

  $mag.turn({
    width: w,
    height: h,
    duration: 620,
    display: isWide ? 'double' : 'single',
    page: 1,
    acceleration: !isChrome(),
    gradients: true,
    turnCorners: PROGRAMMATIC_TURN_CORNERS,
    autoCenter: true,
    elevation: 24,
    cornerSize: 0,
    pages: initialPages,
    when: {
      turning(event, page, newPage) {
        if (readerState?.transitioning) return
        // 检查是否到达边界
        const totalPages = $mag.turn('pages')
        if (newPage > totalPages) {
          event.preventDefault()
          return
        }
        _turning = true
      },
      turned(event, page) {
        _turning = false
        emit('page-changed', page)
        requestAnimationFrame(() => {
          if (!$mag.turn('is')) return
          ensureTurnPageCapacity($mag, page + 1)
          $(this).turn('center')
          watchPageMapChanges()
        })
        scheduleLoad()
      },
      missing(event, pages) {
        const $book = $(this)
        pages.forEach(async (pageNum) => {
          if (pageNum === 1) {
            const $el = $('<div/>').css({ width: readerState._pageW, height: readerState._pageH })
            try {
              if ($book.turn('addPage', $el, 1)) {
                $el.html(buildCoverHtml())
              }
            } catch (e) {
              console.warn('Failed to add cover page:', e)
            }
            return
          }

          if (pageMap.has(pageNum)) {
            addPage(pageNum, $book, readerState._pageW, readerState._pageH)
            return
          }

          // 如果所有章节已加载完，直接显示"完"
          if (readerState._chaptersLoaded >= readerState._apiTotalChapters) {
            const $el = $('<div/>').css({ width: readerState._pageW, height: readerState._pageH })
            $el.html(`<div class="gradient"></div><div class="page-content page-end">完</div>`)
            try {
              $book.turn('addPage', $el, pageNum)
            } catch (e) {
              console.warn('Failed to add end page:', e)
            }
            return
          }

          const $el = $('<div/>').css({ width: readerState._pageW, height: readerState._pageH })
          $el.html(`<div class="gradient"></div><div class="page-loader"><div class="loading-spinner small"></div></div>`)
          try {
            $book.turn('addPage', $el, pageNum)
          } catch (e) {
            console.warn('Failed to add placeholder page:', e)
            return
          }

          if (readerState._chaptersLoaded >= readerState._apiTotalChapters) return
          await waitForChapterAndRender(pageNum, $book)
        })
      }
    }
  })

  await delay(50)
  for (let p = 1; p <= initialPages; p++) {
    addPage(p, $mag, readerState._pageW, readerState._pageH)
  }

  $mag.turn('disabled', false)
  $mag.turn('page', 1)
  $mag.turn('center')

  const handleViewportResize = () => {
    const nextPageSize = readerState.calculatePageSize()
    const w2 = nextPageSize.bookW
    const h2 = nextPageSize.bookH
    const nextCornerSize = getTurnCornerSize()
    readerState._pageW = nextPageSize.pageW
    readerState._pageH = nextPageSize.pageH
    $vp.css({ width: window.innerWidth, height: window.innerHeight })
    $mag.turn('size', w2, h2)

    const turnInstance = $mag.data('turn')
    if (turnInstance?.opts) {
      turnInstance.opts.cornerSize = nextCornerSize
    }

    $mag.turn('center')
    applyPageScaleToCSS(computePageScale())

    if (_resizeTimer) clearTimeout(_resizeTimer)
    _resizeTimer = setTimeout(() => {
      const result = readerReflowPages()
      if (!result) return

      const { previousPage, newTotal } = result
      if (newTotal > 0 && $mag.turn('is')) {
        try {
          $mag.turn('pages', Math.max(2, newTotal))
        } catch (e) {
          console.warn('[resize] 更新turn.js页数失败:', e)
        }

        const targetPage = Math.min(previousPage, newTotal)
        refreshRenderedPages($mag, nextPageSize.pageW, nextPageSize.pageH)

        try {
          $mag.turn('page', targetPage)
        } catch (e) {
          console.warn('[resize] 恢复页码失败:', e)
        }
      }
    }, 500)
  }

  _handleViewportResize = handleViewportResize

  $(window).off('resize.reader').on('resize.reader', handleViewportResize)
  document.removeEventListener('fullscreenchange', handleViewportResize)
  document.addEventListener('fullscreenchange', handleViewportResize)

  if (_viewportTouchCapture) {
    rawViewportEl.removeEventListener('touchstart', _viewportTouchCapture, true)
  }
  _viewportTouchCapture = handleAndroidViewportTouchStart
  rawViewportEl.addEventListener('touchstart', _viewportTouchCapture, { capture: true, passive: true })

  $(document).off('keydown.reader').on('keydown.reader', e => {
    if (_turning) return
    const currentPage = $mag.turn('page')
    const totalPages = $mag.turn('pages')
    if (e.key === 'ArrowRight' && currentPage >= totalPages) return
    if (e.key === 'ArrowRight') $mag.turn('next')
    if (e.key === 'ArrowLeft') $mag.turn('previous')
  })

  $vp
    .off('touchstart.reader touchend.reader click.readerPreview')
    .on('touchstart.reader', e => {
      const touch = e.originalEvent.touches[0]
      _tx = touch.clientX
      _ty = touch.clientY
    })
    .on('touchend.reader', e => {
      if (_turning) return

      if (isAndroidAdaptiveMode()) {
        return
      }

      const touch = e.originalEvent.changedTouches[0]
      const dx = touch.clientX - _tx
      const dy = touch.clientY - _ty
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        // 检查是否到达最后一页
        const currentPage = $mag.turn('page')
        const totalPages = $mag.turn('pages')
        if (dx < 0 && currentPage >= totalPages) return  // 不能再下一页了
        dx < 0 ? $mag.turn('next') : $mag.turn('previous')
      }
    })
    .on('click.readerPreview', '.page-content img, .scanned-page img, .cover-page img', openImagePreview)

  emit('initialized')
  readerState.setMagazineInstance($mag)

  const prepareTask = ensureBookPrepared(props.currentBook, {
    preloadCount: readerState.getInitialPreloadCount(props.currentBook)
  }).then(() => {
    if (!$mag.turn('is')) return
    ensureTurnPageCapacity($mag)
    watchPageMapChanges()
  }).catch(e => {
    console.warn('Failed to prepare book after flipbook init:', e)
  })

  await prepareTask

  if ($mag.turn('is')) {
    if (!IS_ANDROID_DEVICE) {
      // PC 端：等待前 3 页（封面 + 2 页内容）就绪后翻开书本
      initialLoading.value = true
      const waitStart = Date.now()
      await waitForInitialVisualReady([2, 3])
      const elapsed = Date.now() - waitStart
      // 保证加载遮罩至少显示 400ms，避免视觉闪烁
      if (elapsed < 400) await delay(400 - elapsed)
      initialLoading.value = false
      await delay(100)
      if ($mag.turn('is')) {
        $mag.turn('page', 2)
      }
    }
    // Android：保持在封面页（第 1 页），不做任何翻页
  }
}

function destroyTurnInstance() {
  _turning = false
  initialLoading.value = false
  
  if (_resizeTimer) {
    clearTimeout(_resizeTimer)
    _resizeTimer = null
  }
  
  readerState.clearMagazineInstance()
  
  $magazine = null
  _lastPageMapSize = 0

  if (_pageMapWatcher) {
    clearInterval(_pageMapWatcher)
    _pageMapWatcher = null
  }

  try {
    const rawMagazineEl = toRaw(magazineEl.value)
    const $book = $(rawMagazineEl)
    if ($book?.turn?.('is')) {
      $book.turn('destroy')
    }

    const rawViewportEl = toRaw(viewportEl.value)
    $(rawViewportEl)?.off('touchstart.reader touchend.reader click.readerPreview')
    if (_viewportTouchCapture) {
      rawViewportEl?.removeEventListener('touchstart', _viewportTouchCapture, true)
      _viewportTouchCapture = null
    }
  } catch (e) {
    console.warn('Failed to destroy flipbook:', e)
  }

  $(document).off('keydown.reader')
  $(window).off('resize.reader')
  if (_handleViewportResize) {
    document.removeEventListener('fullscreenchange', _handleViewportResize)
    _handleViewportResize = null
  }
}

function destroyFlipbook() {
  destroyTurnInstance()
  abortAllRequests()
  pageMap?.clear()
  pageCache?.clear()
  chapterPageMap?.clear()
  readerState._apiTotalChapters = 0
  readerState._chaptersLoaded = 0
  readerState._pageW = 0
  readerState._pageH = 0
  readerState._preparedFile = ''
}

function flipToPage(page) {
  if (!magazineEl.value) return
  const $book = $(toRaw(magazineEl.value))
  if (!$book.turn('is')) return

  const currentPages = $book.turn('pages')
  if (page > currentPages) {
    try {
      $book.turn('pages', page)
      for (let p = currentPages + 1; p <= page; p++) {
        if (!$book.turn('hasPage', p)) {
          addPage(p, $book, readerState._pageW, readerState._pageH)
        }
      }
    } catch (e) {
      console.warn('flipToPage failed while expanding pages:', e)
    }
  }

  // 刷新目标页及其前后相邻页
  const refreshRange = [page - 1, page, page + 1].filter(p => p > 1 && $book.turn('hasPage', p))
  refreshRange.forEach(p => {
    try {
      const bookData = $book.data()
      const $pageEl = $(bookData?.pageObjs?.[p])
      if ($pageEl?.length) {
        const hasLoader = $pageEl.find('.page-loader').length > 0
        if (hasLoader && pageMap.has(p)) {
          const content = pageMap.get(p)
          mountHtmlPage($pageEl, content, p, readerState._pageW, readerState._pageH)
        }
      }
    } catch (e) {
      console.warn('flipToPage refresh failed:', p, e)
    }
  })

  if (!_turning) {
    $book.turn('page', page)
  }
}

async function animateCloseToCover() {
  if (!magazineEl.value) return
  const $book = $(toRaw(magazineEl.value))
  if (!$book.turn('is')) return

  $book.turn('stop')
  const originalDuration = $book.turn('options').duration || 1000
  $book.turn('options', { duration: 620 })
  
  flipToPageImmediately(1)
  
  await delay(680)
  
  $book.turn('options', { duration: originalDuration })
}

const MAX_RETRY = 3
function flipToPageImmediately(page, retryCount = 0) {
  if (!magazineEl.value) return
  const $book = $(toRaw(magazineEl.value))
  if (!$book.turn('is')) {
    if (retryCount < MAX_RETRY) {
      setTimeout(() => flipToPageImmediately(page, retryCount + 1), 200)
    }
    return
  }

  try {
    $book.turn('stop')
    const currentPages = $book.turn('pages')
    if (page > currentPages) {
      $book.turn('pages', page)
      for (let p = currentPages + 1; p <= page; p++) {
        if (!$book.turn('hasPage', p)) {
          addPage(p, $book, readerState._pageW, readerState._pageH)
        }
      }
    }
    // 刷新目标页及其前后相邻页
    const refreshRange = [page - 1, page, page + 1].filter(p => p > 1 && $book.turn('hasPage', p))
    refreshRange.forEach(p => {
      try {
        const bookData = $book.data()
        const $pageEl = $(bookData?.pageObjs?.[p])
        if ($pageEl?.length) {
          const hasLoader = $pageEl.find('.page-loader').length > 0
          if (hasLoader && pageMap.has(p)) {
            const content = pageMap.get(p)
            mountHtmlPage($pageEl, content, p, readerState._pageW, readerState._pageH)
          }
        }
      } catch (e) {
        console.warn('flipToPageImmediately refresh failed:', p, e)
      }
    })
    $book.turn('page', page)
  } catch (e) {
    console.warn('flipToPageImmediately failed:', e)
  }
}

function prevPage() {
  if (_turning || !magazineEl.value) return
  $(toRaw(magazineEl.value)).turn('previous')
}

function nextPage() {
  if (_turning || !magazineEl.value) return
  const $book = $(toRaw(magazineEl.value))
  ensureTurnPageCapacity($book, props.currentPage + 2)
  $book.turn('next')
}

function refreshPage() {
  if (!magazineEl.value) return
  const $book = $(toRaw(magazineEl.value))
  if ($book.turn('is')) {
    const current = $book.turn('page')
    $book.turn('stop')
    setTimeout(() => {
      $book.turn('page', current)
    }, 100)
  }
}

defineExpose({
  initFlipbook,
  destroyFlipbook,
  flipToPage,
  animateCloseToCover,
  flipToPageImmediately,
  prevPage,
  nextPage,
  refreshPage
})

onUnmounted(() => {
  closeImagePreview()
  destroyFlipbook()
})
</script>