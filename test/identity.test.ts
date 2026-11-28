import { afterEach, describe, expect, it, vi } from 'vitest'
import { PupsClient } from '../src/client.js'
import { parseConfig } from '../src/discovery.js'
import { isPupsError, type PupsError } from '../src/errors.js'
import { FEED_REL } from '../src/feed.js'
import { ACCESS_PROPERTY, accessLevel } from '../src/host-meta.js'
import { bearerChallenge, identityChallenge } from '../src/identity.js'
import type { Scope } from '../src/scopes.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import { createMockServer, type MockOptions } from './mock-server.js'

const clientId = 'https://app.example/oauth/client.json'
const redirectUri = 'https://app.example/callback'
const polls = 'https://polls.example.com'
const clients: PupsClient[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) client.close()
})

async function connect(options: MockOptions & { scopes?: Scope[]; grant?: string[] } = {}) {
  const mock = createMockServer(options)
  const store = new MemoryTokenStore()
  const client = new PupsClient({ clientId, redirectUri, store, fetch: mock.fetch })
  clients.push(client)
  const pending = await client.createAuthorization('tim.example.com', { scopes: options.scopes ?? ['identify', 'identity-tokens'] })
  const { session } = await client.completeAuthorization(mock.authorize(pending.url, { grant: options.grant }), pending)
  if (options.expiresIn && options.expiresIn < 1) await new Promise(resolve => setTimeout(resolve, 5))
  return { mock, client, store, session: session! }
}

async function failure(promise: Promise<unknown>): Promise<PupsError> {
  try {
    await promise
  } catch (e) {
    if (isPupsError(e)) return e
    throw e
  }
  throw new Error('expected a PupsError')
}

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString())
const exchanges = (mock: ReturnType<typeof createMockServer>) => mock.state.requests.filter(r => r.url.endsWith('/oauth/token')).length

describe('discovery', () => {
  it('tells whether the server issues identity tokens', async () => {
    const client = new PupsClient({ clientId, redirectUri, store: new MemoryTokenStore(), fetch: createMockServer().fetch })
    clients.push(client)
    const server = await client.discover('tim.example.com')
    expect(server.identityTokens).toBe(true)
    expect(server.jwksUri).toBe('https://tim.example.com/pups/jwks.json')
  })

  it('needs both jwks_uri and the scope', () => {
    const { config } = createMockServer().state
    const parse = (changes: Record<string, unknown>) => parseConfig({ ...config, ...changes }, 'https://tim.example.com/', ['tim.example.com'])
    expect(parse({}).identityTokens).toBe(true)
    expect(parse({ jwks_uri: undefined }).identityTokens).toBe(false)
    const insecure = parse({ jwks_uri: 'http://tim.example.com/jwks.json' })
    expect(insecure.identityTokens).toBe(false)
    expect('jwksUri' in insecure).toBe(false)
    expect(parse({ scopes_supported: ['identify'] })).toMatchObject({ identityTokens: false, jwksUri: config.jwks_uri })
  })

  it('refuses to ask for the scope at a server without identity tokens', async () => {
    const mock = createMockServer({ identityTokens: false })
    const client = new PupsClient({ clientId, redirectUri, store: new MemoryTokenStore(), fetch: mock.fetch })
    clients.push(client)
    expect((await failure(client.createAuthorization('tim.example.com', { scopes: ['identity-tokens'] }))).code).toBe('invalid_scope')
  })
})

describe('identityToken()', () => {
  it('exchanges the access token for an identity token for the audience', async () => {
    const { mock, session } = await connect()
    expect(session.hasScope('identity-tokens')).toBe(true)
    expect(session.handle).toBe('@tim.example.com')
    const { token, expiresAt, read } = await session.identityToken(polls)
    expect(token).toBe(mock.state.identityTokens[0]!.token)
    expect(read).toBe(false)
    expect(Math.abs(expiresAt.getTime() - Date.now() - 60_000)).toBeLessThan(2000)
    expect(claims(token)).toMatchObject({ aud: polls, sub: 'https://tim.example.com/', iss: 'https://tim.example.com', client_id: clientId })
    expect((await session.identityToken(polls)).token).not.toBe(token)
    expect(claims(token).scope).toBeUndefined()
  })

  it('fails without the scope, before and at the server', async () => {
    const { mock, session } = await connect({ scopes: ['identify', 'identity-tokens'], grant: ['identify'] })
    expect(session.hasScope('identity-tokens')).toBe(false)
    const before = exchanges(mock)
    expect((await failure(session.identityToken(polls))).code).toBe('insufficient_scope')
    expect(exchanges(mock)).toBe(before)
    // A server that dropped the scope since: the grant lacks it there.
    const granted = await connect()
    granted.mock.state.grants[0]!.scopes = ['identify']
    const e = await failure(granted.session.identityToken(polls))
    expect(e).toMatchObject({ code: 'insufficient_scope', status: 400 })
  })

  it('fails at a server without identity tokens', async () => {
    const { mock, session } = await connect()
    mock.state.config.scopes_supported = mock.state.config.scopes_supported.filter(s => s != 'identity-tokens')
    await session.refreshServer()
    expect(session.server.identityTokens).toBe(false)
    expect((await failure(session.identityToken(polls))).code).toBe('unsupported')
  })

  it('rejects a bad audience, before sending and at the server', async () => {
    const { mock, session } = await connect()
    const before = exchanges(mock)
    for (const audience of [`${polls}/`, `${polls}/vote`, 'http://polls.example.com', 'polls.example.com', 'https://POLLS.example.com'])
      expect((await failure(session.identityToken(audience))).code).toBe('invalid_target')
    expect(exchanges(mock)).toBe(before)
    for (const audience of ['https://localhost', 'https://192.168.1.1', 'https://printer.local'])
      expect(await failure(session.identityToken(audience))).toMatchObject({ code: 'invalid_target', status: 400 })
  })

  it('reports the rate limit as retryable', async () => {
    const { session } = await connect({ identityTokensPerMinute: 2 })
    await session.identityToken(polls)
    await session.identityToken(polls)
    const e = await failure(session.identityToken(polls))
    expect(e).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 60, retryable: true })
  })

  it('renews an expired access token before the exchange', async () => {
    const { mock, session } = await connect({ expiresIn: 0.001 })
    expect(mock.state.refreshCount).toBe(0)
    expect(claims((await session.identityToken(polls)).token).aud).toBe(polls)
    expect(mock.state.refreshCount).toBe(1)
  })

  it('renews an access token the server rejects, once', async () => {
    const { mock, session } = await connect()
    mock.state.grants[0]!.current.access = 'replaced'
    expect(claims((await session.identityToken(polls)).token).aud).toBe(polls)
    expect(mock.state.refreshCount).toBe(1)
  })

  it('ends with session_expired when the grant was revoked', async () => {
    const { mock, session } = await connect()
    mock.state.grants[0]!.revoked = true
    expect((await failure(session.identityToken(polls))).code).toBe('session_expired')
    expect(session.active).toBe(false)
  })
})

describe('fetchAsOwner()', () => {
  it('sends a new identity token for the origin of the URL, and never the access token', async () => {
    const { mock, session } = await connect()
    const seen: (string | null)[] = []
    mock.state.sites[polls] = async request => {
      seen.push(request.headers.get('Authorization'))
      expect(await request.json()).toEqual({ choice: 2 })
      expect(request.headers.get('Content-Type')).toBe('application/json')
      return Response.json({ ok: true })
    }
    const vote = () => session.fetchAsOwner(`${polls}/polls/42/votes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer something-else' },
      body: JSON.stringify({ choice: 2 }),
    })
    expect(await (await vote()).json()).toEqual({ ok: true })
    await vote()
    expect(seen).toEqual(mock.state.identityTokens.map(t => `Bearer ${t.token}`))
    expect(new Set(seen).size).toBe(2)
    expect(mock.state.identityTokens.map(t => t.aud)).toEqual([polls, polls])
    expect(seen.some(s => s?.includes(mock.state.grants[0]!.current.access))).toBe(false)
  })

  it('uses the origin with its port', async () => {
    const { mock, session } = await connect()
    mock.state.sites['https://polls.example.com:8443'] = () => new Response(null, { status: 204 })
    expect((await session.fetchAsOwner('https://polls.example.com:8443/x?y=1#z')).status).toBe(204)
    expect(mock.state.identityTokens[0]!.aud).toBe('https://polls.example.com:8443')
  })

  it('does not follow a redirect to another origin with the token', async () => {
    const { mock, session } = await connect()
    const evil: (string | null)[] = []
    mock.state.sites[polls] = () => new Response(null, { status: 307, headers: { Location: 'https://evil.example/steal' } })
    mock.state.sites['https://evil.example'] = request => {
      evil.push(request.headers.get('Authorization'))
      return new Response('ok')
    }
    // The mock follows redirects with all headers, as the worst case, unless asked not to.
    await mock.fetch(`${polls}/vote`, { headers: { Authorization: 'Bearer leaked' } })
    expect(evil).toEqual(['Bearer leaked'])
    evil.length = 0
    const response = await session.fetchAsOwner(`${polls}/vote`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(307)
    expect(evil).toEqual([])
  })

  it('throws the errors of identityToken() without sending anything', async () => {
    const { mock, session } = await connect({ scopes: ['identify'] })
    let sent = false
    mock.state.sites[polls] = () => {
      sent = true
      return new Response('ok')
    }
    expect((await failure(session.fetchAsOwner(`${polls}/vote`))).code).toBe('insufficient_scope')
    expect(sent).toBe(false)
  })
})

const comments = 'https://comments.example.org'
const queue = `${comments}/groups/feed-readers/queue.json`

const problem = (status: number, detail: string, challenge: string) => new Response(
  JSON.stringify({ type: 'https://bigwide.net/ns/identity-required', title: 'This feed needs an identity token', detail }),
  { status, headers: { 'Content-Type': 'application/problem+json', 'WWW-Authenticate': challenge } })

/**
 * A restricted feed at comments.example.org that checks tokens as RFC-10 says, against the claims the mock issued
 * (not signatures). `rejected` makes it reject single tokens by `jti`, as if they had expired.
 */
function restrictedFeed(mock: ReturnType<typeof createMockServer>, allowed = true) {
  const seen: { method: string; url: string; authorization: string | null }[] = []
  const rejected = new Set<string>()
  mock.state.sites[comments] = request => {
    const authorization = request.headers.get('Authorization')
    seen.push({ method: request.method, url: request.url, authorization })
    if (!authorization)
      return problem(401, 'Only the moderators of Feed Readers can read this feed.', 'Bearer realm="Feed Readers: moderation queue", identity="required"')
    const issued = mock.state.identityTokens.find(t => `Bearer ${t.token}` == authorization)
    if (!issued || issued.aud != comments || issued.exp * 1000 < Date.now() || rejected.has(issued.jti))
      return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } })
    if (issued.scope == 'read' && request.method != 'GET' && request.method != 'HEAD')
      return new Response(null, { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } })
    if (request.url.endsWith('/moved.json')) return new Response(null, { status: 302, headers: { Location: 'https://evil.example/feed.json' } })
    if (!allowed) return problem(403, 'Ask the admin of comments.example.org to add you.', 'Bearer realm="Feed Readers: moderation queue"')
    return Response.json({ version: 'https://jsonfeed.org/version/1.1', title: 'Queue', items: [] }, { headers: { 'Cache-Control': 'private', Vary: 'Authorization' } })
  }
  return { seen, rejected, tokens: () => seen.map(s => s.authorization) }
}

const readExchanges = (mock: ReturnType<typeof createMockServer>) => mock.state.identityTokens.filter(t => t.scope == 'read').length

describe('read tokens', () => {
  it('asks for scope=read, takes the lifetime from expires_in, and reuses the token for its origin', async () => {
    const { mock, session } = await connect({ readTokenLifetime: 7200 })
    const first = await session.identityToken(comments, { read: true })
    expect(first.read).toBe(true)
    expect(claims(first.token)).toMatchObject({ scope: 'read', aud: comments })
    expect(Math.abs(first.expiresAt.getTime() - Date.now() - 7_200_000)).toBeLessThan(2000)
    expect(await session.identityToken(comments, { read: true })).toEqual(first)
    expect(readExchanges(mock)).toBe(1)
    // Another origin gets its own; tokens for actions are never the read token.
    expect((await session.identityToken(polls, { read: true })).token).not.toBe(first.token)
    expect(claims((await session.identityToken(comments)).token).scope).toBeUndefined()
    expect(readExchanges(mock)).toBe(2)
  })

  it('keeps read tokens with the session, so a reload reuses them', async () => {
    const { mock, store, session } = await connect()
    const { token } = await session.identityToken(comments, { read: true })
    expect((await store.get(clientId, session.me))!.readTokens![comments]!.token).toBe(token)
    const other = new PupsClient({ clientId, redirectUri, store, fetch: mock.fetch })
    clients.push(other)
    const restored = (await other.restore(session.me))!
    expect((await restored.identityToken(comments, { read: true })).token).toBe(token)
    expect(readExchanges(mock)).toBe(1)
  })

  it('renews the read token shortly before it expires', async () => {
    const { mock, session } = await connect()
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const { token } = await session.identityToken(comments, { read: true })
    vi.setSystemTime(start + 23 * 3600_000)
    expect((await session.identityToken(comments, { read: true })).token).toBe(token)
    vi.setSystemTime(start + 86_400_000 - 5 * 60_000)
    const renewed = await session.identityToken(comments, { read: true })
    expect(renewed.token).not.toBe(token)
    expect(readExchanges(mock)).toBe(2)
    expect(renewed.expiresAt.getTime()).toBe(Date.now() + 86_400_000)
  })

  it('forgets the read token of an origin', async () => {
    const { mock, store, session } = await connect()
    const { token } = await session.identityToken(comments, { read: true })
    await session.forgetReadToken(queue)
    expect((await store.get(clientId, session.me))!.readTokens).toEqual({})
    expect((await session.identityToken(comments, { read: true })).token).not.toBe(token)
    expect(readExchanges(mock)).toBe(2)
  })

  it('checks the audience and the scope like tokens for actions', async () => {
    const { session } = await connect({ scopes: ['identify'] })
    expect((await failure(session.identityToken(comments, { read: true }))).code).toBe('insufficient_scope')
    expect((await failure((await connect()).session.identityToken(`${comments}/`, { read: true }))).code).toBe('invalid_target')
  })

  it('refuses a server that answers scope=read with a token for an action', async () => {
    const mock = createMockServer()
    // A server that ignores scope=read.
    const client = new PupsClient({
      clientId, redirectUri, store: new MemoryTokenStore(),
      fetch: async (input, init) => {
        const response = await mock.fetch(input, init)
        if (!String(init?.body).includes('token-exchange')) return response
        const { scope: _, ...body } = await response.json() as Record<string, unknown>
        return Response.json(body)
      },
    })
    clients.push(client)
    const pending = await client.createAuthorization('tim.example.com', { scopes: ['identity-tokens'] })
    const { session: wrapped } = await client.completeAuthorization(mock.authorize(pending.url), pending)
    expect((await failure(wrapped!.identityToken(comments, { read: true }))).code).toBe('unsupported')
  })
})

describe('fetchFeedAsOwner()', () => {
  it('fetches with the read token of the origin, reused across fetches and feeds there', async () => {
    const { mock, session } = await connect()
    const feed = restrictedFeed(mock)
    const response = await session.fetchFeedAsOwner(queue)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { title: string }).title).toBe('Queue')
    await session.fetchFeedAsOwner(queue, { headers: { 'If-None-Match': '"x"' } })
    await session.fetchFeedAsOwner(`${comments}/other.json`, { method: 'HEAD' })
    expect(readExchanges(mock)).toBe(1)
    expect(new Set(feed.tokens())).toEqual(new Set([`Bearer ${mock.state.identityTokens[0]!.token}`]))
    expect(feed.seen.map(s => s.method)).toEqual(['GET', 'GET', 'HEAD'])
    expect(feed.seen.some(s => s.authorization?.includes(mock.state.grants[0]!.current.access))).toBe(false)
  })

  it('tries once more with a new read token after 401 invalid_token', async () => {
    const { mock, session } = await connect()
    const feed = restrictedFeed(mock)
    await session.fetchFeedAsOwner(queue)
    feed.rejected.add(mock.state.identityTokens[0]!.jti)
    expect((await session.fetchFeedAsOwner(queue)).status).toBe(200)
    expect(readExchanges(mock)).toBe(2)
    expect(new Set(feed.tokens()).size).toBe(2)
    // The new token is kept.
    await session.fetchFeedAsOwner(queue)
    expect(readExchanges(mock)).toBe(2)
  })

  it('tries only once, and not for a 401 without invalid_token', async () => {
    const { mock, session } = await connect()
    const feed = restrictedFeed(mock)
    mock.state.sites[comments] = request => {
      feed.seen.push({ method: request.method, url: request.url, authorization: request.headers.get('Authorization') })
      return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } })
    }
    expect((await session.fetchFeedAsOwner(queue)).status).toBe(401)
    expect(feed.seen.length).toBe(2)
    mock.state.sites[comments] = () => problem(401, 'nope', 'Bearer identity="required"')
    expect((await session.fetchFeedAsOwner(queue)).status).toBe(401)
    expect(readExchanges(mock)).toBe(2)
  })

  it('returns 403 for a domain without access, with the server\'s explanation', async () => {
    const { mock, session } = await connect()
    restrictedFeed(mock, false)
    const response = await session.fetchFeedAsOwner(queue)
    expect(response.status).toBe(403)
    expect(await identityChallenge(response)).toEqual({
      realm: 'Feed Readers: moderation queue', title: 'This feed needs an identity token', detail: 'Ask the admin of comments.example.org to add you.',
    })
  })

  it('never sends the read token across origins on a redirect', async () => {
    const { mock, session } = await connect()
    restrictedFeed(mock)
    const evil: (string | null)[] = []
    mock.state.sites['https://evil.example'] = request => {
      evil.push(request.headers.get('Authorization'))
      return Response.json({})
    }
    expect((await session.fetchFeedAsOwner(`${comments}/moved.json`)).status).toBe(302)
    expect(evil).toEqual([])
  })

  it('never sends a read token with an action', async () => {
    const { mock, session } = await connect()
    const feed = restrictedFeed(mock)
    await session.fetchFeedAsOwner(queue)
    const read = `Bearer ${mock.state.identityTokens[0]!.token}`
    expect((await session.fetchAsOwner(`${comments}/groups/feed-readers/accept`, { method: 'POST', body: '{}' })).status).toBe(200)
    const action = feed.seen.at(-1)!
    expect(action.method).toBe('POST')
    expect(action.authorization).not.toBe(read)
    expect(claims(action.authorization!.slice(7)).scope).toBeUndefined()
    const post = session.fetchFeedAsOwner(queue, { method: 'POST' as 'GET' })
    expect((await failure(post)).code).toBe('invalid_request')
  })
})

describe('challenges', () => {
  it('parses the Bearer challenge of WWW-Authenticate', () => {
    expect(bearerChallenge('Bearer realm="Feed Readers: moderation queue", identity="required"'))
      .toEqual({ realm: 'Feed Readers: moderation queue', identity: 'required' })
    expect(bearerChallenge('Basic realm="x", Bearer error="invalid_token", error_description="The token expired"'))
      .toEqual({ error: 'invalid_token', error_description: 'The token expired' })
    expect(bearerChallenge('Basic dXNlcjpwYXNz==, bearer Identity=optional')).toEqual({ identity: 'optional' })
    expect(bearerChallenge('Bearer realm="a \\"b\\" c", Basic realm="simple"')).toEqual({ realm: 'a "b" c' })
    expect(bearerChallenge('Bearer')).toEqual({})
    expect(bearerChallenge('Newauth realm="apps", type=1, Basic realm="simple"')).toBeUndefined()
    expect(bearerChallenge(null)).toBeUndefined()
  })

  it('reads the challenge and the problem body, and leaves the body readable', async () => {
    const response = problem(401, 'Only the moderators can read this feed.', 'Bearer realm="Queue", identity="required"')
    expect(await identityChallenge(response)).toEqual({
      identity: 'required', realm: 'Queue', title: 'This feed needs an identity token', detail: 'Only the moderators can read this feed.',
    })
    expect(((await response.json()) as { detail: string }).detail).toBe('Only the moderators can read this feed.')
    expect(await identityChallenge(new Response('{}', { headers: { 'WWW-Authenticate': 'Bearer identity="optional"' } }))).toEqual({ identity: 'optional' })
    expect(await identityChallenge(new Response('{}', { headers: { 'WWW-Authenticate': 'Bearer identity="maybe"' } }))).toEqual({})
    expect(await identityChallenge(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toBeUndefined()
  })
})

describe('access levels', () => {
  it('reads the access property of a feed link', () => {
    const level = (value?: string | null) => accessLevel(value === undefined ? {} : { properties: { [ACCESS_PROPERTY]: value } })
    expect(level()).toBe('public')
    expect(level(null)).toBe('public')
    expect(level('public')).toBe('public')
    expect(level('restricted')).toBe('restricted')
    expect(level('personal')).toBe('personal')
    expect(level('optional')).toBe('optional')
    expect(level('members-only')).toBe('restricted')
    expect(level('')).toBe('restricted')
  })

  it('lists feeds with their access level', async () => {
    const { mock, session } = await connect({ scopes: ['identify', 'appdata', 'identity-tokens'] })
    mock.state.hostMeta.links.push(
      { rel: FEED_REL, href: queue, type: 'application/feed+json', titles: { default: 'Queue' }, properties: { [ACCESS_PROPERTY]: 'restricted' } },
      { rel: FEED_REL, href: 'https://tim.example.com/feed.json', type: 'application/feed+json' },
    )
    const feeds = await session.listFeeds()
    expect(feeds.map(f => [f.url, f.access])).toEqual([[queue, 'restricted'], ['https://tim.example.com/feed.json', 'public']])
  })
})
