/**
 * Table of Contents Management
 * Handles TOC loading and navigation
 */

export function createTocManager() {
  const tocList = []
  let _loadedTocFile = ''

  async function loadToc(bookFile) {
    if (!bookFile) return
    if (_loadedTocFile === bookFile && tocList.length > 0) return
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
      tocList.splice(0, tocList.length, ...rawItems.map(item => ({
        label: item.title || item.label || '',
        title: item.title || item.title || '',
        targetPage: Number(item.page) || Number(item.targetPage) || 0
      })))
    } catch (err) {
      console.warn('[TOC] 加载目录失败:', err)
    }
  }

  function updateTocPageMapping(chapterNum, chapterId, chapterHref, startTurnPage, endTurnPage) {
    if (!chapterHref) return

    if (chapterId) {
      window.chapterPageMap?.set?.(chapterId, { startPage: startTurnPage, endPage: endTurnPage })
    }

    if (!tocList.length) return

    for (const item of tocList) {
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

    if (window.tocVisible !== undefined) {
      window.tocVisible.value = false
    }

    if (typeof flipToPageFn === 'function') {
      await flipToPageFn(targetPage)
    } else {
      if (window.currentPage !== undefined) {
        window.currentPage.value = targetPage
      }
    }

    await fastLoadToTurnPage(targetPage)

    if (typeof flipToPageFn === 'function') {
      await flipToPageFn(targetPage)
    }
  }

  function toggleToc() {
    if (window.tocVisible !== undefined) {
      window.tocVisible.value = !window.tocVisible.value
    }
  }

  async function fastLoadToTurnPage(targetTurnPage, loadNextChapterFn, chaptersLoaded, apiTotalChapters, abortController) {
    const LOAD_AHEAD_THRESHOLD = 4
    const BUFFER = LOAD_AHEAD_THRESHOLD + 2

    while (chaptersLoaded < apiTotalChapters && window.totalPages?.value < targetTurnPage + BUFFER) {
      if (abortController?.signal?.aborted) return
      if (typeof loadNextChapterFn === 'function') {
        await loadNextChapterFn()
      } else {
        break
      }
    }
  }

  function getTocList() {
    return [...tocList]
  }

  function clearToc() {
    tocList.splice(0, tocList.length)
    _loadedTocFile = ''
  }

  return {
    loadToc,
    updateTocPageMapping,
    jumpToTocItem,
    toggleToc,
    fastLoadToTurnPage,
    getTocList,
    clearToc
  }
}
