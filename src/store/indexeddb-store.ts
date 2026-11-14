import type { SessionRecord, TokenStore } from './token-store.js'

const sessionsStore = 'sessions'
const keysStore = 'keys'
const keyId = 'aes-gcm'

/** What is stored per session: identifying fields in clear, everything else encrypted. */
interface EncryptedRow {
  id: string
  clientId: string
  me: string
  iv: Uint8Array<ArrayBuffer>
  data: ArrayBuffer
}

export interface IndexedDbTokenStoreOptions {
  /** Name of the IndexedDB database. Default: `pups-client`. */
  dbName?: string
}

/**
 * The default store: session records in IndexedDB, encrypted with AES-GCM (256 bits, random IV per write).
 *
 * The key is a non-extractable `CryptoKey`, kept in the same database. Its raw bytes are never available to
 * JavaScript, so a copy of the browser profile, a backup or a synced profile contains only ciphertext.
 *
 * This does **not** protect against script running on the app's own origin (XSS): such script can use the key like
 * the app does. Protect the app with a strict Content Security Policy. See the concept, "Credential storage".
 */
export class IndexedDbTokenStore implements TokenStore {
  readonly #dbName: string
  #db?: Promise<IDBDatabase>
  #key?: Promise<CryptoKey>

  constructor(options: IndexedDbTokenStoreOptions = {}) {
    this.#dbName = options.dbName ?? 'pups-client'
  }

  async get(clientId: string, me: string) {
    const db = await this.#open()
    const row = await request<EncryptedRow | undefined>(db.transaction(sessionsStore).objectStore(sessionsStore).get(rowId(clientId, me)))
    return row && this.#decrypt(row)
  }

  async list(clientId: string) {
    const db = await this.#open()
    const rows = await request<EncryptedRow[]>(db.transaction(sessionsStore).objectStore(sessionsStore).getAll())
    const records = await Promise.all(rows.filter(r => r.clientId == clientId).map(r => this.#decrypt(r)))
    return records.filter((r): r is SessionRecord => !!r)
  }

  async put(record: SessionRecord) {
    const id = rowId(record.clientId, record.me)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const plaintext = new TextEncoder().encode(JSON.stringify(record))
    // The row id is authenticated as additional data, so a ciphertext can't be moved to another row.
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, await this.#getKey(), plaintext)
    const row: EncryptedRow = { id, clientId: record.clientId, me: record.me, iv, data }
    const tx = (await this.#open()).transaction(sessionsStore, 'readwrite')
    tx.objectStore(sessionsStore).put(row)
    await done(tx)
  }

  async delete(clientId: string, me: string) {
    const tx = (await this.#open()).transaction(sessionsStore, 'readwrite')
    tx.objectStore(sessionsStore).delete(rowId(clientId, me))
    await done(tx)
  }

  async #decrypt(row: EncryptedRow): Promise<SessionRecord | undefined> {
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: new TextEncoder().encode(row.id) }, await this.#getKey(), row.data)
      return JSON.parse(new TextDecoder().decode(plaintext))
    } catch {
      // The key was lost or the row is corrupt. The tokens are unusable; forget them.
      await this.delete(row.clientId, row.me)
      return
    }
  }

  #open(): Promise<IDBDatabase> {
    return this.#db ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(this.#dbName, 1)
      open.onupgradeneeded = () => {
        open.result.createObjectStore(sessionsStore, { keyPath: 'id' })
        open.result.createObjectStore(keysStore)
      }
      open.onsuccess = () => {
        // Let a newer version of the library in another tab upgrade the database.
        open.result.onversionchange = () => {
          open.result.close()
          this.#db = undefined
        }
        resolve(open.result)
      }
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error('The pups-client database is blocked by another tab.'))
    })
  }

  #getKey(): Promise<CryptoKey> {
    return this.#key ??= (async () => {
      const db = await this.#open()
      const existing = await request<CryptoKey | undefined>(db.transaction(keysStore).objectStore(keysStore).get(keyId))
      if (existing) return existing
      const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      // Another tab may have stored a key meanwhile. Read and write in one transaction, without awaiting anything
      // else in between, and keep whichever key is stored.
      const tx = db.transaction(keysStore, 'readwrite')
      const store = tx.objectStore(keysStore)
      const result = new Promise<CryptoKey>((resolve, reject) => {
        const get = store.get(keyId)
        get.onsuccess = () => {
          if (get.result) return resolve(get.result)
          store.put(generated, keyId)
          resolve(generated)
        }
        get.onerror = () => reject(get.error)
      })
      await done(tx)
      return result
    })().catch(e => {
      this.#key = undefined
      throw e
    })
  }
}

const rowId = (clientId: string, me: string) => `${clientId}\n${me}`

const request = <T>(req: IDBRequest): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

const done = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'))
})
