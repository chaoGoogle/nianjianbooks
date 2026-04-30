/**
 * Chapter Loading and Preloading Management
 * Handles chapter loading, background preloading, and content preparation
 */

import { delay, log } from '../constants.js'
import { requestChapterData } from './bookApi.js'
import { getPdfPageUrl } from './pdfManager.js'
import { splitContentToPages } from './pagination.js'

const LOAD_AHEAD_THRESHOLD = 4

export function createChapterLoader(stateManager) {
  let _preloadController = null

  async function loadNextChapter(currentBook, totalPagesRef, displayTotalPagesRef, pageLoadingRef, abortController) {
    if (stateManager._loadingChapter || stateManager._chaptersLoaded >= stateManager._apiTotalChapters) return
    if (abortController?.signal?.aborted || !currentBook?.file) return

    stateManager._loadingChapter = true
    if (pageLoadingRef) pageLoadingRef.value = true
    const chapterNum = stateManager._chaptersLoaded + 1
    const fileName = currentBook?.file || ''

    try {
      let data = stateManager.pageCache.get(chapterNum)
      if (!data) {
        data = await requestChapterData(fileName, chapterNum, {
          signal: abortController?.signal
        })
        if (!data) {
          // No more content, mark as loaded
          stateManager._chaptersLoaded = chapterNum
          stateManager._loadingChapter = false
          if (pageLoadingRef) pageLoadingRef.value = false
          if (stateManager._chaptersLoaded >= stateManager._apiTotalChapters) {
            if (displayTotalPagesRef) displayTotalPagesRef.value = totalPagesRef.value
          }
          return
        }
        if (data) {
          stateManager.pageCache.set(chapterNum, data)
        }
      }

      if (abortController?.signal?.aborted) return

      // Check if scanned PDF (empty content)
      const isScannedPdf = data?.type === 'pdf' && (data?.isScanned || !data?.content?.trim())

      if (data?.content?.trim()) {
        // Normal text content
        const chunks = splitContentToPages(data.content, data.type, stateManager._pageW, stateManager._pageH)
        const startTurnPage = totalPagesRef.value + 1

        chunks.forEach(html => {
          const turnPage = totalPagesRef.value + 1
          stateManager.pageMap.set(turnPage, html)
          totalPagesRef.value = turnPage
        })

        const endTurnPage = totalPagesRef.value

        if (data.chapterHref || data.chapterId) {
          if (stateManager.updateTocPageMapping) {
            stateManager.updateTocPageMapping(chapterNum, data.chapterId, data.chapterHref, startTurnPage, endTurnPage)
          }
        }
      } else if (isScannedPdf) {
        let pageImageUrl = data?.pageImageUrl || ''
        if (!pageImageUrl) {
          pageImageUrl = await getPdfPageUrl(fileName, chapterNum)
          if (pageImageUrl) {
            data.pageImageUrl = pageImageUrl
            stateManager.pageCache.set(chapterNum, data)
          }
        }
        if (pageImageUrl) {
          const turnPage = totalPagesRef.value + 1
          stateManager.pageMap.set(turnPage, buildPdfImagePageHtml(pageImageUrl, chapterNum))
          totalPagesRef.value = turnPage
        }
      }

      stateManager._chaptersLoaded = chapterNum
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(`[chapter] failed to load ${chapterNum}`, e)
      }
      stateManager._chaptersLoaded = chapterNum
    } finally {
      stateManager._loadingChapter = false
      if (pageLoadingRef) pageLoadingRef.value = false
      if (stateManager._chaptersLoaded >= stateManager._apiTotalChapters) {
        if (displayTotalPagesRef) displayTotalPagesRef.value = totalPagesRef.value
      }
    }
  }

  function startBackgroundPreload(loadNextChapterFn, chaptersLoadedRef, apiTotalChaptersRef, abortController) {
    stopBackgroundPreload()
    
    _preloadController = new AbortController()
    
    backgroundPreloadLoop(
      _preloadController.signal,
      loadNextChapterFn,
      chaptersLoadedRef,
      apiTotalChaptersRef,
      abortController
    ).catch(e => {
      if (e.name !== 'AbortError') {
        console.warn('[preload] Background preload error:', e)
      }
    })
    
    return _preloadController.signal
  }

  function stopBackgroundPreload() {
    if (_preloadController) {
      _preloadController.abort()
      _preloadController = null
    }
  }

  async function backgroundPreloadLoop(signal, loadNextChapterFn, chaptersLoadedRef, apiTotalChaptersRef, abortController) {
    log('[preload] Starting async background preload, currently loaded:', chaptersLoadedRef.value, '/', apiTotalChaptersRef.value)
    
    while (chaptersLoadedRef.value < apiTotalChaptersRef.value && !signal.aborted) {
      if (chaptersLoadedRef.value >= apiTotalChaptersRef.value) break
      if (abortController?.signal?.aborted) break
      
      if (stateManager._loadingChapter) {
        await delay(100)
        continue
      }
      
      await loadNextChapterFn()
      
      if (!signal.aborted && chaptersLoadedRef.value < apiTotalChaptersRef.value) {
        await delay(50)
      }
    }
    log('[preload] Background preload completed, loaded chapters:', chaptersLoadedRef.value, '/', apiTotalChaptersRef.value)
  }

  function scheduleInitialWarmup(preloadCount, loadNextChapterFn, abortController, chaptersLoadedRef, apiTotalChaptersRef) {
    if (preloadCount <= 0) return
    
    let remaining = preloadCount
    const pump = async () => {
      if (abortController?.signal?.aborted || remaining <= 0) return
      if (stateManager._loadingChapter || chaptersLoadedRef.value >= apiTotalChaptersRef.value) return

      remaining -= 1
      await loadNextChapterFn()

      if (abortController?.signal?.aborted || remaining <= 0) return
      setTimeout(pump, 0)
    }

    setTimeout(pump, 0)
  }

  async function fastLoadToTurnPage(targetTurnPage, loadNextChapterFn, totalPagesRef, chaptersLoadedRef, apiTotalChaptersRef, abortController) {
    if (chaptersLoadedRef.value >= apiTotalChaptersRef.value) return Promise.resolve()
    const BUFFER = LOAD_AHEAD_THRESHOLD + 2

    return (async () => {
      while (chaptersLoadedRef.value < apiTotalChaptersRef.value && totalPagesRef.value < targetTurnPage + BUFFER) {
        if (stateManager._loadingChapter) {
          await delay(30)
          continue
        }
        if (abortController?.signal?.aborted) return
        await loadNextChapterFn()
      }
    })().catch(e => {
      if (e.name !== 'AbortError') {
        console.warn('[fastLoad] error:', e)
      }
    })
  }

  function buildPdfImagePageHtml(imageUrl, pdfPageNum) {
    return '<div class="scanned-page" data-pdf-page="' + pdfPageNum + '"><img src="' + imageUrl + '" alt="" /></div>'
  }

  return {
    loadNextChapter,
    startBackgroundPreload,
    stopBackgroundPreload,
    scheduleInitialWarmup,
    fastLoadToTurnPage,
    buildPdfImagePageHtml
  }
}
