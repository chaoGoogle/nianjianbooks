/**
 * PDF Page List Management
 * Handles fetching and caching of PDF page URLs
 */

import { createCacheKey, readCache, writeCache } from '../requestCache.js'
import { enc } from '../constants.js'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const API = API_BASE + '/api'
const PDF_PAGE_URLS_TTL = 1000 * 60 * 60 * 24 * 7

const _pdfPageListPromises = new Map()

function resolveApiAssetUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (/^(data:|blob:|https?:\/\/)/i.test(url)) return url
  if (url.startsWith('/api/')) return `${API_BASE}${url}`
  return url
}

export function getPdfPageListCacheKey(fileName) {
  return createCacheKey('pdf-page-urls', fileName)
}

export async function fetchPdfPageList(fileName, { forceRefresh = false } = {}) {
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

export async function getPdfPageUrl(fileName, pageNum) {
  if (!fileName || !pageNum) return ''
  const data = await fetchPdfPageList(fileName)
  return data.urls?.[pageNum - 1] || ''
}
