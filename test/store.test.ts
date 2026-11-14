import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { IndexedDbTokenStore } from '../src/store/indexeddb-store.js'
import type { SessionRecord } from '../src/store/token-store.js'

const record = (me: string, clientId = 'https://app.example/oauth/client.json'): SessionRecord => ({
  clientId,
  me,
  server: {} as SessionRecord['server'],
  scopes: ['write:/appdata/app.example/'],
  accessToken: 'secret-access-token',
  accessTokenExpiresAt: 4_000_000_000_000,
  refreshToken: 'secret-refresh-token',
  createdAt: 1,
  lastUsedAt: 2,
})

const rawRows = (dbName: string) => new Promise<unknown[]>((resolve, reject) => {
  const open = indexedDB.open(dbName)
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const request = open.result.transaction('sessions').objectStore('sessions').getAll()
    request.onsuccess = () => {
      open.result.close()
      resolve(request.result)
    }
  }
})

describe('IndexedDbTokenStore', () => {
  it('stores, lists and deletes records', async () => {
    const store = new IndexedDbTokenStore({ dbName: 'test-crud' })
    await store.put(record('https://a.example/'))
    await store.put(record('https://b.example/'))
    await store.put(record('https://c.example/', 'https://other.example/client.json'))
    expect(await store.get('https://app.example/oauth/client.json', 'https://a.example/')).toEqual(record('https://a.example/'))
    expect((await store.list('https://app.example/oauth/client.json')).map(r => r.me).sort()).toEqual(['https://a.example/', 'https://b.example/'])
    await store.delete('https://app.example/oauth/client.json', 'https://a.example/')
    expect(await store.get('https://app.example/oauth/client.json', 'https://a.example/')).toBeUndefined()
  })

  it('keeps tokens encrypted at rest with a non-extractable key', async () => {
    const store = new IndexedDbTokenStore({ dbName: 'test-encryption' })
    await store.put(record('https://a.example/'))
    const raw = JSON.stringify(await rawRows('test-encryption'), (_, v) => v instanceof ArrayBuffer ? new TextDecoder().decode(v) : v)
    expect(raw).not.toContain('secret-access-token')
    expect(raw).not.toContain('secret-refresh-token')
    // A second store instance (another tab) reads the same key from the database.
    expect(await new IndexedDbTokenStore({ dbName: 'test-encryption' }).get('https://app.example/oauth/client.json', 'https://a.example/'))
      .toMatchObject({ refreshToken: 'secret-refresh-token' })
  })
})
