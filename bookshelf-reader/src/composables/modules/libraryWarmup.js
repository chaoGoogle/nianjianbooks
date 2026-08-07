/**
 * Library Warmup Functions
 * Handles background cache warming and book list refresh scheduling
 */

import { delay } from '../constants.js'
import { requestBookMeta } from './bookApi.js'

const APK_WARMUP_DELAY = 1200
const APK_WARMUP_BATCH_PAUSE = 80

const warmedFiles = new Set()

export function scheduleLibraryWarmup(stateFlags, booksRef, warmLibraryCacheFn) {
  if (stateFlags.libraryWarmupScheduled || stateFlags.libraryWarmupRunning || !booksRef.value.length) return
  stateFlags.libraryWarmupScheduled = true

  const startWarmup = () => {
    stateFlags.libraryWarmupScheduled = false
    if (stateFlags.libraryWarmupRunning || !booksRef.value.length) return
    warmLibraryCacheFn().catch(e => {
      console.warn('[warmup] background library cache failed:', e)
    })
  }

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(startWarmup, { timeout: 3000 })
    return
  }
  setTimeout(startWarmup, APK_WARMUP_DELAY)
}

export async function warmLibraryCache(stateFlags, booksRef) {
  if (stateFlags.libraryWarmupRunning) return
  stateFlags.libraryWarmupRunning = true

  try {
    const snapshot = [...booksRef.value]
    for (const book of snapshot) {
      if (!book?.file || warmedFiles.has(book.file)) continue
      await requestBookMeta(book.file)
      warmedFiles.add(book.file)
      await delay(APK_WARMUP_BATCH_PAUSE)
    }
  } finally {
    stateFlags.libraryWarmupRunning = false
  }
}

export function scheduleBooksRefresh(stateFlags, fetchBooksFn, delayMs = 800) {
  if (stateFlags.booksRefreshTimer) {
    clearTimeout(stateFlags.booksRefreshTimer)
    stateFlags.booksRefreshTimer = null
  }
  stateFlags.booksRefreshTimer = setTimeout(() => {
    fetchBooksFn({ silent: true }).catch(err => {
      console.warn('[books] background refresh failed:', err)
    })
  }, delayMs)
}
