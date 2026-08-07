/**
 * Book API Functions
 * Handles communication with backend book APIs
 */

import axios from 'axios'
import { enc } from '../constants.js'

const API = '/nianjian/api'

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

export async function fetchBooks(api, { silent = false, forceRefresh = false } = {}) {
  const response = await axios.get(`${api}/books`, {
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
