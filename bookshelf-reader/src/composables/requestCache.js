const CACHE_PREFIX = 'bookshelf-reader:cache:v3:'
const LEGACY_CACHE_PREFIXES = ['bookshelf-reader:cache:v1:', 'bookshelf-reader:cache:v2:']
const DB_NAME = 'bookshelf-reader-cache-v2'
const LEGACY_DB_NAMES = ['bookshelf-reader-cache']
const STORE_NAME = 'requests'
const LARGE_PAYLOAD_THRESHOLD = 120000
const memoryCache = new Map()
const inflightRequests = new Map()

let dbPromise = null
let legacyCleanupDone = false

function getStorage() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    return window.localStorage
  } catch (_) {
    return null
  }
}

function getIndexedDb() {
  try {
    if (typeof window === 'undefined' || !window.indexedDB) return null
    return window.indexedDB
  } catch (_) {
    return null
  }
}

function now() {
  return Date.now()
}

function getMemoryEntry(key) {
  const entry = memoryCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now()) {
    memoryCache.delete(key)
    return null
  }
  return entry.value
}

function setMemoryEntry(key, value, ttl) {
  memoryCache.set(key, {
    value,
    expiresAt: now() + ttl
  })
}

function openDb() {
  const indexedDb = getIndexedDb()
  if (!indexedDb) return Promise.resolve(null)
  if (dbPromise) return dbPromise

  dbPromise = new Promise(resolve => {
    try {
      cleanupLegacyCaches()
      const request = indexedDb.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch (_) {
      resolve(null)
    }
  })

  return dbPromise
}

function cleanupLegacyCaches() {
  if (legacyCleanupDone) return
  legacyCleanupDone = true

  const storage = getStorage()
  if (storage) {
    try {
      const staleKeys = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (!key) continue
        if (LEGACY_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) {
          staleKeys.push(key)
        }
      }
      staleKeys.forEach(key => storage.removeItem(key))
    } catch (_) {
    }
  }

  const indexedDb = getIndexedDb()
  if (!indexedDb) return
  try {
    LEGACY_DB_NAMES.forEach(name => {
      indexedDb.deleteDatabase(name)
    })
  } catch (_) {
  }
}

function idbGet(key) {
  return openDb().then(db => new Promise(resolve => {
    if (!db) {
      resolve(null)
      return
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => resolve(null)
    } catch (_) {
      resolve(null)
    }
  }))
}

function idbSet(key, value) {
  return openDb().then(db => new Promise(resolve => {
    if (!db) {
      resolve(false)
      return
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.objectStore(STORE_NAME).put(value, key)
    } catch (_) {
      resolve(false)
    }
  }))
}

function idbDelete(key) {
  return openDb().then(db => new Promise(resolve => {
    if (!db) {
      resolve(false)
      return
    }
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.objectStore(STORE_NAME).delete(key)
    } catch (_) {
      resolve(false)
    }
  }))
}

export function createCacheKey(scope, id = '') {
  return `${scope}:${id}`
}

export async function readCache(key, ttl) {
  const memoryValue = getMemoryEntry(key)
  if (memoryValue !== null) {
    return memoryValue
  }

  const storage = getStorage()
  if (storage) {
    try {
      const raw = storage.getItem(CACHE_PREFIX + key)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && parsed.expiresAt > now()) {
          setMemoryEntry(key, parsed.value, ttl)
          return parsed.value
        }
        storage.removeItem(CACHE_PREFIX + key)
      }
    } catch (_) {
      try {
        storage.removeItem(CACHE_PREFIX + key)
      } catch (__){}
    }
  }

  const persisted = await idbGet(key)
  if (!persisted || typeof persisted !== 'object') return null
  if (persisted.expiresAt <= now()) {
    await idbDelete(key)
    return null
  }

  setMemoryEntry(key, persisted.value, ttl)
  return persisted.value
}

export async function writeCache(key, value, ttl, { persist = true } = {}) {
  const expiresAt = now() + ttl
  setMemoryEntry(key, value, ttl)
  if (!persist) return

  const payload = { value, expiresAt }
  const storage = getStorage()
  if (storage) {
    try {
      const raw = JSON.stringify(payload)
      if (raw.length <= LARGE_PAYLOAD_THRESHOLD) {
        storage.setItem(CACHE_PREFIX + key, raw)
      } else {
        storage.removeItem(CACHE_PREFIX + key)
      }
    } catch (_) {
      try {
        storage.removeItem(CACHE_PREFIX + key)
      } catch (__){}
    }
  }

  await idbSet(key, payload)
}

export async function clearCache(key) {
  memoryCache.delete(key)
  const storage = getStorage()
  if (storage) {
    try {
      storage.removeItem(CACHE_PREFIX + key)
    } catch (_) {
    }
  }
  await idbDelete(key)
}

export async function withCache(key, { ttl, forceRefresh = false, fetcher, persist = true }) {
  if (!forceRefresh) {
    const cached = await readCache(key, ttl)
    if (cached !== null) {
      return cached
    }

    if (inflightRequests.has(key)) {
      return inflightRequests.get(key)
    }
  }

  const request = Promise.resolve()
    .then(fetcher)
    .then(async value => {
      const shouldPersist = typeof persist === 'function' ? persist(value) : persist
      await writeCache(key, value, ttl, { persist: shouldPersist })
      return value
    })
    .finally(() => {
      inflightRequests.delete(key)
    })

  inflightRequests.set(key, request)
  return request
}
