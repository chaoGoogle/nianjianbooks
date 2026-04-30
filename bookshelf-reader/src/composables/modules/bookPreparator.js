/**
 * Book Preparation and Management
 * Handles book preparation, metadata fetching, and PDF preloading
 */

import { log } from '../constants.js'
import { requestBookMeta } from './bookApi.js'
import { fetchPdfPageList } from './pdfManager.js'
import { calculatePageSize } from './pageLayout.js'

const IS_ANDROID_DEVICE = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

export function createBookPreparator(stateManager, chapterLoader) {
  async function prepareBook(book, totalPagesRef, displayTotalPagesRef, currentPageRef, pageLoadingRef, getAbortControllerFn) {
    if (!book?.file) return

    if (stateManager._preparedFile === book.file && stateManager._apiTotalChapters > 0 && totalPagesRef.value > 0) {
      return
    }

    if (stateManager._preparePromise && stateManager._preparingFile === book.file) {
      return stateManager._preparePromise
    }

    stateManager._preparingFile = book.file
    stateManager._preparePromise = (async () => {
      stateManager.resetBookState()
      const pageSize = calculatePageSize()
      stateManager._pageW = pageSize.pageW
      stateManager._pageH = pageSize.pageH
      
      const abortController = getAbortControllerFn()

      await fetchBookMeta(book.file)

      if (book.type === 'pdf') {
        fetchPdfPageList(book.file)
          .then(pageData => {
            const pdfCover = pageData.urls?.[0] || ''
            if (!pdfCover) return
            // Update cover if needed by caller
          })
          .catch(e => {
            console.warn('PDF cover URL fetch failed:', e)
          })
      }
      stateManager._preparedFile = book.file
      
      const preloadCount = stateManager.getInitialPreloadCount(book)
      const loadNextChapterFn = () => 
        chapterLoader.loadNextChapter(
          book,
          totalPagesRef,
          displayTotalPagesRef,
          pageLoadingRef,
          abortController
        )
      
      chapterLoader.scheduleInitialWarmup(
        preloadCount,
        loadNextChapterFn,
        abortController,
        { value: stateManager._chaptersLoaded },
        { value: stateManager._apiTotalChapters }
      )
      
      chapterLoader.startBackgroundPreload(
        loadNextChapterFn,
        { value: stateManager._chaptersLoaded },
        { value: stateManager._apiTotalChapters },
        abortController
      )

      if (!IS_ANDROID_DEVICE && book.type === 'pdf' && stateManager._apiTotalChapters > 0) {
        setTimeout(() => {
          preloadPdfPages(book.file, stateManager._apiTotalChapters)
        }, 2000)
      }

    })().finally(() => {
      stateManager._preparePromise = null
      stateManager._preparingFile = ''
    })

    return stateManager._preparePromise
  }

  async function fetchBookMeta(fileName) {
    const metaData = await requestBookMeta(fileName)
    stateManager._apiTotalChapters = metaData.totalPages || 0
    stateManager._bookType = metaData.type || ''
    return metaData
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
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    log('[preloadPdfPages] completed')
  }

  return {
    prepareBook,
    fetchBookMeta,
    preloadPdfPages
  }
}
