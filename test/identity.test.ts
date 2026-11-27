import { afterEach, describe, expect, it } from 'vitest'
import { PupsClient } from '../src/client.js'
import { parseConfig } from '../src/discovery.js'
import { isPupsError, type PupsError } from '../src/errors.js'
import type { Scope } from '../src/scopes.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import { createMockServer, type MockOptions } from './mock-server.js'

const clientId = 'https://app.example/oauth/client.json'
const redirectUri = 'https://app.example/callback'
const polls = 'https://polls.example.com'
const clients: PupsClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

async function connect(options: MockOptions & { scopes?: Scope[]; grant?: string[] } = {}) {
  const mock = createMockServer(options)
  const client = new PupsClient({ clientId, redirectUri, store: new MemoryTokenStore(), fetch: mock.fetch })
  clients.push(client)
  const pending = await client.createAuthorization('tim.example.com', { scopes: options.scopes ?? ['identify', 'identity-tokens'] })
  const { session } = await client.completeAuthorization(mock.authorize(pending.url, { grant: options.grant }), pending)
  if (options.expiresIn && options.expiresIn < 1) await new Promise(resolve => setTimeout(resolve, 5))
  return { mock, client, session: session! }
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
    const token = await session.identityToken(polls)
    expect(token).toBe(mock.state.identityTokens[0]!.token)
    expect(claims(token)).toMatchObject({ aud: polls, sub: 'https://tim.example.com/', iss: 'https://tim.example.com', client_id: clientId })
    expect(await session.identityToken(polls)).not.toBe(token)
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
    expect(claims(await session.identityToken(polls)).aud).toBe(polls)
    expect(mock.state.refreshCount).toBe(1)
  })

  it('renews an access token the server rejects, once', async () => {
    const { mock, session } = await connect()
    mock.state.grants[0]!.current.access = 'replaced'
    expect(claims(await session.identityToken(polls)).aud).toBe(polls)
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
