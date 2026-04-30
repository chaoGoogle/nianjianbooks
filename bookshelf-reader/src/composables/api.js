import axios from 'axios'
import { enc } from './constants.js'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const API = API_BASE + '/api'

function resolveApiAssetUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (/^(data:|blob:|https?:\/\/)/i.test(url)) return url
  if (url.startsWith('/api/')) return `${API_BASE}${url}`
  return url
}

export async function fetchBooks() {
  const res = await axios.get(`${API}/books`)
  const json = res.data
  if (!json.success) {
    throw new Error('加载失败')
  }

  return (json.data || []).map(book => ({
    ...book,
    cover: resolveApiAssetUrl(book.cover)
  }))
}

export async function fetchBookMeta(fileName) {
  const res = await axios.get(`${API}/file/pages?file=${enc(fileName)}`)
  const json = res.data
  if (!json.success) {
    throw new Error('获取书籍元数据失败')
  }
  return json.data
}

export async function extractChapter(fileName, chapterNum, signal) {
  const res = await axios.get(
    `${API}/file/extract?file=${enc(fileName)}&page=${chapterNum}&pageSize=1`,
    { signal }
  )
  const json = res.data
  if (json.success && json.data?.pages?.length) {
    return json.data.pages[0]
  }
  return null
}
