/** useBookReader - PDF Related Functions */
import { enc, log } from '../constants.js'
import { createCacheKey, readCache, writeCache } from '../requestCache.js'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const API = API_BASE + '/api'
const PDF_PAGE_URLS_TTL = 1000 * 60 * 60 * 24 * 7

function resolveApiAssetUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (/^(data:|blob:|https?:\/\/)/i.test(url)) return url
  if (url.startsWith('/api/')) return `${API_BASE}${url}`
  return url
}

export function getPdfPageListCacheKey(fileName) {
  return createCacheKey('pdf-page-urls', fileName)
}

export async function fetchPdfPageList(fileName, { forceRefresh = false }, _pdfPageListPromises) {
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

export async function getPdfPageUrl(fileName, pageNum, _pdfPageListPromises) {
  if (!fileName || !pageNum) return ''
  const data = await fetchPdfPageList(fileName, {}, _pdfPageListPromises)
  return data.urls?.[pageNum - 1] || ''
}

export function buildPdfImagePageHtml(imageUrl, pdfPageNum) {
  return '<div class="scanned-page" data-pdf-page="' + pdfPageNum + '"><img src="' + imageUrl + '" alt="" /></div>'
}

export async function preloadPdfPages(fileName, totalPages, fetchPdfPageListFn, delay) {
  if (!fileName?.toLowerCase()?.endsWith('.pdf')) return
  if (!totalPages || totalPages <= 0) return

  const pageList = await fetchPdfPageListFn(fileName)
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
