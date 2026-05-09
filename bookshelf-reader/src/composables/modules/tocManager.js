/**
 * Table of Contents Management
 * Handles TOC loading and navigation
 */

const DEFAULT_TOC = [
  { title: '2023年亮点', page: 5 },
  { title: '荣誉榜', page: 11 },
  { title: '工作概述', page: 15 },
  { title: '公共服务', page: 21 },
  { title: '一、开放服务', page: 23 },
  { title: '二、陈列展览', page: 31 },
  { title: '三、社会教育', page: 43 },
  { title: '四、宣传推广', page: 85 },
  { title: '五、数字化建设', page: 105 },
  { title: '六、文化创意', page: 111 },
  { title: '科学研究', page: 125 },
  { title: '七、文物鉴定审核', page: 127 },
  { title: '八、藏品征集管理', page: 131 },
  { title: '九、文物保护修复', page: 143 },
  { title: '十、学术与出版', page: 151 },
  { title: '综合管理', page: 167 },
  { title: '十一、党群建设', page: 169 },
  { title: '十二、组织管理', page: 185 },
  { title: '十三、安全保卫', page: 195 },
  { title: '大事记', page: 198 }
]

export function createTocManager() {
  const tocList = []
  let _loadedTocFile = ''

  async function loadToc(bookFile) {
    if (!bookFile) return
    if (_loadedTocFile === bookFile && tocList.length > 0) return
    _loadedTocFile = bookFile

    tocList.splice(0, tocList.length, ...DEFAULT_TOC.map(item => ({
      label: item.title || item.label || '',
      title: item.title || '',
      targetPage: Number(item.page) || 0
    })))
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
