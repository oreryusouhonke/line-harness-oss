type ClientCacheEntry<T> = {
  key: string
  savedAt: number
  value: T
}

const BUILD_ID = process.env.APP_COMMIT_SHA || 'local'
const CACHE_PREFIX = `lh_client_cache:${BUILD_ID}:`
const SCOPE_STORAGE_KEY = 'lh_client_cache_scope'
const MAX_MEMORY_ENTRIES = 120
const MAX_STORAGE_ENTRY_CHARS = 300_000

let currentScope = 'anonymous'
const memoryCache = new Map<string, ClientCacheEntry<unknown>>()

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined'
}

function hashKey(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function scopedKey(key: string): string {
  return `${currentScope}:${key}`
}

function storageKey(key: string): string {
  return `${CACHE_PREFIX}${encodeURIComponent(currentScope)}:${hashKey(key)}`
}

function trimMemoryCache(): void {
  while (memoryCache.size > MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value
    if (!oldestKey) break
    memoryCache.delete(oldestKey)
  }
}

function removeStoredClientCache(keepCurrentBuild = false): void {
  if (!storageAvailable()) return
  try {
    const keys: string[] = []
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index)
      if (
        key?.startsWith('lh_client_cache:') &&
        (!keepCurrentBuild || !key.startsWith(CACHE_PREFIX))
      ) keys.push(key)
    }
    for (const key of keys) window.sessionStorage.removeItem(key)
  } catch {
    // Private mode and strict browser policies can make sessionStorage unavailable.
  }
}

/**
 * Separate cached CRM data by the authenticated staff member. Switching users
 * in the same tab clears the previous user's entries so customer data never
 * crosses login sessions.
 */
export function setClientCacheScope(scope: string): void {
  const normalized = scope.trim() || 'anonymous'
  if (currentScope === normalized) return

  memoryCache.clear()
  if (storageAvailable()) {
    try {
      const storedScope = window.sessionStorage.getItem(SCOPE_STORAGE_KEY)
      if (storedScope && storedScope !== normalized) removeStoredClientCache()
      else removeStoredClientCache(true)
      window.sessionStorage.setItem(SCOPE_STORAGE_KEY, normalized)
    } catch {
      // Keep the in-memory cache available even when storage is blocked.
    }
  }
  currentScope = normalized
}

export function invalidateClientCache(): void {
  memoryCache.clear()
  removeStoredClientCache()
}

export function clearClientCache(): void {
  invalidateClientCache()
  if (storageAvailable()) {
    try {
      window.sessionStorage.removeItem(SCOPE_STORAGE_KEY)
    } catch {
      // Ignore storage cleanup failures during logout.
    }
  }
  currentScope = 'anonymous'
}

export function readClientCache<T>(key: string, maxAgeMs: number): ClientCacheEntry<T> | null {
  const now = Date.now()
  const inMemory = memoryCache.get(scopedKey(key)) as ClientCacheEntry<T> | undefined
  if (inMemory) {
    if (now - inMemory.savedAt <= maxAgeMs) {
      memoryCache.delete(scopedKey(key))
      memoryCache.set(scopedKey(key), inMemory)
      return inMemory
    }
    memoryCache.delete(scopedKey(key))
  }

  if (!storageAvailable()) return null
  try {
    const raw = window.sessionStorage.getItem(storageKey(key))
    if (!raw) return null
    const stored = JSON.parse(raw) as ClientCacheEntry<T>
    if (stored.key !== key || !Number.isFinite(stored.savedAt) || now - stored.savedAt > maxAgeMs) {
      window.sessionStorage.removeItem(storageKey(key))
      return null
    }
    memoryCache.set(scopedKey(key), stored)
    trimMemoryCache()
    return stored
  } catch {
    return null
  }
}

export function writeClientCache<T>(key: string, value: T): void {
  const entry: ClientCacheEntry<T> = { key, savedAt: Date.now(), value }
  memoryCache.delete(scopedKey(key))
  memoryCache.set(scopedKey(key), entry)
  trimMemoryCache()

  if (!storageAvailable()) return
  const serialized = (() => {
    try {
      return JSON.stringify(entry)
    } catch {
      return null
    }
  })()
  if (!serialized || serialized.length > MAX_STORAGE_ENTRY_CHARS) return

  try {
    // Avoid filling the browser's small synchronous storage with large reports.
    window.sessionStorage.setItem(storageKey(key), serialized)
  } catch {
    // If the tab cache reached its quota, discard older build/session data and
    // retry once. A disabled sessionStorage must never break the application.
    try {
      removeStoredClientCache()
      window.sessionStorage.setItem(storageKey(key), serialized)
    } catch {
      // Keep serving from the in-memory cache.
    }
  }
}
