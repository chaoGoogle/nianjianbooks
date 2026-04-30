/** useBookReader - API Related Functions */
import axios from 'axios'
import { enc } from '../constants.js'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const API = API_BASE + '/api'

export async function requestBooks({ forceRefresh = false } = {}) {
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

export async function requestBookMeta(fileName) {
  const response = await axios.get(`${API}/file/pages?file=${enc(fileName)}`)
  const payload = response.data
  if (!payload.success) {
    throw new Error('Failed to load book metadata')
  }
  return payload.data
}

export async function requestChapterData(fileName, chapterNum, { signal } = {}) {
  const res = await axios.get(
    `${API}/file/extract?file=${enc(fileName)}&page=${chapterNum}&pageSize=1`,
    signal ? { signal } : undefined
  )
  const json = res.data
  // No more content, mark as loaded
  if (!json.success || !json.data?.pages?.length) {
    return null
  }
  const pageData = json.data.pages[0]
  return {
    content: pageData.content,
    isScanned: !!pageData.isScanned,
    pageImageUrl: '',
    type: json.data.type,
    chapterId: pageData.chapterId || '',
    chapterHref: pageData.chapterHref || ''
  }
}
