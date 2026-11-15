import { afterEach, describe, expect, it } from 'vitest'
import { PupsClient } from '../src/client.js'
import { isPupsError, type PupsErrorCode } from '../src/errors.js'
import type { Scope } from '../src/scopes.js'
import type { SessionChangeEvent } from '../src/session.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import type { TokenStore } from '../src/store/token-store.js'
import { timing } from '../src/tokens.js'
import { createMockServer, type MockOptions } from './mock-server.js'

const clientId = 'https://app.example/oauth/client.json'
const redirectUri = 'https://app.example/callback'
const clients: PupsClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

function newClient(mock: ReturnType<typeof createMockServer>, store: TokenStore = new MemoryTokenStore()) {
  const client = new PupsClient({ clientId, redirectUri, store, fetch: mock.fetch })
  clients.push(client)
  return client
}

async function connect(options: MockOptions & { scopes?: Scope[]; grant?: string[] } = {}) {
  const mock = createMockServer(options)
  const store = new MemoryTokenStore()
  const client = newClient(mock, store)
  const pending = await client.createAuthorization('tim.example.com', { scopes: options.scopes ?? ['identify', 'appdata'] })
  const { session } = await client.completeAuthorization(mock.authorize(pending.url, { grant: options.grant }), pending)
  // With a tiny expires_in, let the access token expire for sure.
  if (options.expiresIn && options.expiresIn < 1) await new Promise(resolve => setTimeout(resolve, 5))
  return { mock, client, store, session: session! }
}

async function errorCode(promise: Promise<unknown>): Promise<PupsErrorCode | 'ok'> {
  try {
    await promise
    return 'ok'
  } catch (e) {
    if (isPupsError(e)) return e.code
    throw e
  }
}

describe('authorization', () => {
  it('signs in and returns the verified identity and the granted scopes', async () => {
    const { session, store } = await connect()
    expect(session.me).toBe('https://tim.example.com/')
    expect(session.scopes).toEqual(['identify', 'write:/appdata/app.example/'])
    expect(session.appDataPath).toBe('/appdata/app.example/')
    expect(await store.get(clientId, session.me)).toMatchObject({ me: session.me })
  })

  it('handles a narrowed grant', async () => {
    const { session } = await connect({ scopes: ['appdata', 'write:/feed/'], grant: ['write:/appdata/app.example/'] })
    expect(session.canWrite('x.json')).toBe(true)
    expect(session.canWrite('/feed/photos.json')).toBe(false)
    expect(session.hasScope('write:/feed/')).toBe(false)
  })

  it('checks the issuer before redeeming the code', async () => {
    const mock = createMockServer()
    const client = newClient(mock)
    const pending = await client.createAuthorization('tim.example.com')
    const callback = mock.authorize(pending.url, { iss: 'https://evil.example' })
    expect(await errorCode(client.completeAuthorization(callback, pending))).toBe('issuer_mismatch')
    expect(mock.state.requests.some(r => r.url.endsWith('/oauth/token'))).toBe(false)
  })

  it('rejects denial, foreign state and invalid scopes', async () => {
    const mock = createMockServer()
    const client = newClient(mock)
    const pending = await client.createAuthorization('tim.example.com')
    expect(await errorCode(client.completeAuthorization(mock.authorize(pending.url, { deny: true }), pending))).toBe('access_denied')
    const other = await client.createAuthorization('tim.example.com')
    expect(await errorCode(client.completeAuthorization(mock.authorize(other.url), pending))).toBe('state_mismatch')
    expect(await errorCode(client.createAuthorization('tim.example.com', { scopes: ['write:/appdata/other.example/'] }))).toBe('invalid_scope')
  })

  it('rejects and revokes tokens for an identity that does not lead to the issuer', async () => {
    const mock = createMockServer()
    mock.state.me = 'https://someone-else.example/'
    const client = newClient(mock)
    const pending = await client.createAuthorization('tim.example.com')
    expect(await errorCode(client.completeAuthorization(mock.authorize(pending.url), pending))).toBe('identity_mismatch')
    expect(mock.state.grants[0]!.revoked).toBe(true)
  })

  it('reports a missing PUPS server', async () => {
    const mock = createMockServer()
    expect(await errorCode(newClient(mock).discover('nobody.example'))).toBe('network')
  })
})

describe('files', () => {
  it('creates, reads, replaces and deletes', async () => {
    const { session, mock } = await connect()
    const created = await session.create('notes/today.md', '# Hello')
    expect(created).toMatchObject({ path: '/appdata/app.example/notes/today.md', created: true, url: 'https://tim.example.com/files/appdata/app.example/notes/today.md' })
    expect(mock.state.files.get(created.path)!.type).toBe('text/markdown; charset=utf-8')

    const file = (await session.get('notes/today.md'))!
    expect(await file.text()).toBe('# Hello')
    expect(file.etag).toBe(created.etag)

    expect(await errorCode(session.create('notes/today.md', 'again'))).toBe('precondition_failed')
    const replaced = await session.replace('notes/today.md', '# Changed', file.etag)
    expect(replaced.created).toBe(false)
    expect(await errorCode(session.replace('notes/today.md', 'stale', file.etag))).toBe('precondition_failed')

    await session.delete('notes/today.md', { ifMatch: replaced.etag })
    expect(await session.get('notes/today.md')).toBeUndefined()
    expect(await errorCode(session.delete('notes/today.md'))).toBe('not_found')
  })

  it('writes JSON values and binary data', async () => {
    const { session, mock } = await connect()
    await session.put('data.json', { items: [1, 2] }, { contentType: 'application/feed+json' })
    expect(new TextDecoder().decode(mock.state.files.get('/appdata/app.example/data.json')!.body)).toBe('{"items":[1,2]}')
    await session.put('pixel.png', new Uint8Array([137, 80, 78, 71]))
    expect(mock.state.files.get('/appdata/app.example/pixel.png')!.body).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  it('rejects what the server would reject, before sending', async () => {
    const { session, mock } = await connect()
    const before = mock.state.requests.length
    expect(await errorCode(session.put('/feed/photos.json', '{}'))).toBe('insufficient_scope')
    expect(await errorCode(session.put('../escape.json', '{}'))).toBe('invalid_path')
    expect(await errorCode(session.put('page.html', '<p>'))).toBe('unsupported_type')
    expect(await errorCode(session.put('feed.php.json', '{}'))).toBe('unsupported_type')
    expect(await errorCode(session.put('notes.md', { not: 'markdown' }))).toBe('invalid_request')
    expect(await errorCode(session.put('big.txt', 'x'.repeat(1001)))).toBe('too_large')
    expect(mock.state.requests.length).toBe(before)
  })

  it('update() retries when someone else wrote in between', async () => {
    const { session } = await connect()
    await session.put('feed.json', { items: ['a'] })
    let calls = 0
    const result = await session.update('feed.json', async file => {
      const feed = await file!.json<{ items: string[] }>()
      // On the first attempt, another app adds an item before we write.
      if (!calls++) await session.put('feed.json', { items: [...feed.items, 'other'] })
      return { items: [...feed.items, 'mine'] }
    })
    expect(calls).toBe(2)
    expect(result!.created).toBe(false)
    expect(await (await session.get('feed.json'))!.json()).toEqual({ items: ['a', 'other', 'mine'] })
  })

  it('update() creates a missing file and can skip writing', async () => {
    const { session } = await connect()
    expect((await session.update('new.json', file => file ? undefined : []))!.created).toBe(true)
    expect(await session.update('new.json', () => undefined)).toBeUndefined()
  })

  it('sends writes through the POST fallback when declared', async () => {
    const { session, mock } = await connect({ postFallback: true })
    await session.put('a.json', '{}')
    await session.delete('a.json')
    const posts = mock.state.requests.filter(r => r.url.startsWith('https://tim.example.com/pups/post'))
    expect(posts.map(r => new URL(r.url).searchParams.get('method'))).toEqual(['PUT', 'DELETE'])
    expect(new URL(posts[0]!.url).searchParams.get('path')).toBe('/appdata/app.example/a.json')
  })
})

describe('host-meta.json', () => {
  it('adds links to own files with allowed rels only', async () => {
    const { session, mock } = await connect({ scopes: ['appdata', 'write:/feed/'] })
    await session.put('/feed/photos.json', '{}')
    await session.hostMeta.addLink({ rel: 'https://bigwide.net/ns/feed', href: '/feed/photos.json', type: 'application/feed+json' })
    expect(mock.state.hostMeta.links.at(-1)).toMatchObject({ href: 'https://tim.example.com/feed/photos.json' })
    await session.hostMeta.addLink({ rel: 'https://app.example/rel/index', href: 'index.json' })

    expect(session.hostMeta.allowsRel('https://other.example/rel', 'index.json')).toBe(false)
    expect(await errorCode(session.hostMeta.addLink({ rel: 'https://bigwide.net/ns/personal-storage', href: 'index.json' }))).toBe('insufficient_scope')
    expect(await errorCode(session.hostMeta.addLink({ rel: 'https://app.example/rel', href: 'https://elsewhere.example/x.json' }))).toBe('insufficient_scope')
    expect(await errorCode(session.hostMeta.setProperty('https://bigwide.net/ns/name', 'Tim'))).toBe('insufficient_scope')
  })

  it('sets properties declared for a granted well-known path', async () => {
    const { session, mock } = await connect({ scopes: ['write:/.well-known/about.md'] })
    expect(session.hostMeta.allowedProperties()).toEqual(['https://bigwide.net/ns/name'])
    await session.hostMeta.setProperty('https://bigwide.net/ns/name', 'Tim')
    expect(mock.state.hostMeta.properties['https://bigwide.net/ns/name']).toBe('Tim')
    expect(await errorCode(session.hostMeta.setProperty('https://bigwide.net/ns/name', 'a\nb'))).toBe('invalid_request')
  })

  it('is unsupported without a host_meta_endpoint', async () => {
    const { session } = await connect({ hostMetaEndpoint: false })
    expect(session.hostMeta.available).toBe(false)
    expect(await errorCode(session.hostMeta.addLink({ rel: 'https://app.example/rel', href: 'x.json' }))).toBe('unsupported')
  })
})

describe('tokens', () => {
  const fastRetries = () => {
    const saved = { ...timing }
    timing.refreshRetryDelaysMs = [5, 10, 20]
    return () => Object.assign(timing, saved)
  }

  it('refreshes an expired access token and stores the rotated refresh token', async () => {
    const { session, mock, store } = await connect({ expiresIn: 0.001 })
    const before = (await store.get(clientId, session.me))!.refreshToken
    await session.put('a.json', '{}')
    expect(mock.state.refreshCount).toBe(1)
    expect((await store.get(clientId, session.me))!.refreshToken).not.toBe(before)
  })

  it('survives a lost refresh response by retrying within the grace period', async () => {
    const restore = fastRetries()
    try {
      const { session, mock } = await connect({ expiresIn: 0.001 })
      mock.state.dropNextRefreshResponse = true
      await session.put('a.json', '{}')
      expect(mock.state.refreshCount).toBe(2)
      expect(mock.state.grants[0]!.revoked).toBe(false)
      expect(session.active).toBe(true)
    } finally {
      restore()
    }
  })

  it('keeps the session when every retry fails, and reports a retryable error', async () => {
    const restore = fastRetries()
    try {
      const { session, mock, store } = await connect({ expiresIn: 0.001 })
      mock.state.failRefreshes = 10
      expect(await errorCode(session.put('a.json', '{}'))).toBe('network')
      expect(await store.get(clientId, session.me)).toBeDefined()
      mock.state.failRefreshes = 0
      await session.put('a.json', '{}')
    } finally {
      restore()
    }
  })

  it('ends the session when the grant was revoked', async () => {
    const { session, client, mock, store } = await connect()
    const events: SessionChangeEvent[] = []
    client.onSessionChange(e => events.push(e))
    mock.state.grants[0]!.revoked = true
    expect(await errorCode(session.put('a.json', '{}'))).toBe('session_expired')
    expect(session.active).toBe(false)
    expect(await store.get(clientId, session.me)).toBeUndefined()
    expect(events.map(e => e.type)).toEqual(['expired'])
  })

  it('refreshes only once when two tabs need a new token at the same time', async () => {
    const { mock, store, session } = await connect({ expiresIn: 0.001 })
    const otherTab = (await newClient(mock, store).restore(session.me))!
    await Promise.all([session.put('a.json', '{}'), otherTab.put('b.json', '{}')])
    expect(mock.state.refreshCount).toBe(1)
    expect(mock.state.grants[0]!.revoked).toBe(false)
  })
})

describe('logout', () => {
  it('forgets the credentials and revokes the grant', async () => {
    const { session, client, mock, store } = await connect()
    const events: SessionChangeEvent[] = []
    client.onSessionChange(e => events.push(e))
    expect(await session.logout()).toEqual({ revoked: true })
    expect(mock.state.grants[0]!.revoked).toBe(true)
    expect(await store.get(clientId, session.me)).toBeUndefined()
    expect(events).toEqual([{ type: 'logout', me: session.me }])
    expect(await errorCode(session.put('a.json', '{}'))).toBe('session_expired')
    expect(await client.restore()).toBeUndefined()
  })

  it('keeps the grant with revoke: false', async () => {
    const { session, mock } = await connect()
    expect(await session.logout({ revoke: false })).toEqual({ revoked: false })
    expect(mock.state.grants[0]!.revoked).toBe(false)
  })
})
