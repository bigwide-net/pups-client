import { sha256Base64url } from '../src/util.js'

/**
 * An in-memory PUPS server for tests, as a `fetch` function. Implements discovery, the authorization code flow
 * (consent is simulated by `authorize()`), refresh with rotation, reuse detection and the grace period, revocation,
 * the upload API (or the POST fallback), private files (RFC-6 "Private areas") and the host-meta endpoint.
 */
export interface MockOptions {
  domain?: string
  postFallback?: boolean
  hostMetaEndpoint?: boolean
  /** Whether the server has a built-in receiver for comments (`comment_endpoint`). */
  commentEndpoint?: boolean
  /** Lifetime of the access token from the code exchange. Refreshed access tokens live 3600 seconds. */
  expiresIn?: number
  graceMs?: number
  maxUploadBytes?: number
}

interface Pair { refresh: string; access: string; used: boolean }
interface Grant {
  clientId: string
  scopes: string[]
  revoked: boolean
  current: Pair
  previous?: { refresh: string; replacedAt: number }
}
interface StoredFile { body: Uint8Array; type: string; etag: string }

let counter = 0
const token = (kind: string) => `${kind}-${++counter}-${Math.random().toString(36).slice(2)}`

export function createMockServer(options: MockOptions = {}) {
  const host = options.domain ?? 'tim.example.com'
  const origin = `https://${host}`
  const graceMs = options.graceMs ?? 60_000
  const config = {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    storage_base: `${origin}/files/`,
    public_base: `${origin}/files/`,
    scopes_supported: ['identify', 'write:/appdata/', 'write:/pups/private/notes/', 'read:/pups/private/notes/'],
    well_known_paths: [
      { path: '/feed.json', url: `${origin}/feed.json`, rels: ['https://bigwide.net/ns/feed'] },
      { path: '/feed/', url: `${origin}/feed/`, rels: ['https://bigwide.net/ns/feed'] },
      { path: '/.well-known/about.md', url: `${origin}/.well-known/about.md`, properties: ['https://bigwide.net/ns/name'] },
      { path: '/pups/pages/', url: `${origin}/pups/pages/`, rels: ['https://bigwide.net/ns/webpup-pages'],
        properties: ['https://bigwide.net/ns/webpup-footer'], link_properties: ['https://bigwide.net/ns/webpup-hidden'] },
      { path: '/pups/private/notes/' },
    ],
    ...options.hostMetaEndpoint ?? true ? { host_meta_endpoint: `${origin}/pups/host-meta` } : {},
    ...options.postFallback ? { post_endpoint: `${origin}/pups/post` } : {},
    ...options.commentEndpoint ? { comment_endpoint: `${origin}/pups/comments` } : {},
    max_upload_bytes: options.maxUploadBytes ?? 1000,
    spec_version: '0.1',
  }

  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; scopes: string[] }>()
  const grants: Grant[] = []
  const discarded = new Set<string>()
  const files = new Map<string, StoredFile>()
  const cached = new Map<string, StoredFile>()
  const hostMeta: { links: Record<string, unknown>[]; properties: Record<string, string> } = {
    links: [{ rel: 'https://bigwide.net/ns/personal-storage', href: `${origin}/personal-storage.json` }],
    properties: {},
  }
  let etagCounter = 0
  const state = {
    config,
    files,
    hostMeta,
    grants,
    requests: [] as { method: string; url: string }[],
    refreshCount: 0,
    /** Process the next refresh, then fail as if the response was lost. */
    dropNextRefreshResponse: false,
    /** Fail the next n refreshes with a network error before processing them. */
    failRefreshes: 0,
    /** Simulate a cache in front of the server: public reads keep returning the version they saw first. */
    cachePublicReads: false,
    me: `${origin}/`,
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(status == 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const apiError = (status: number, error: string) => json(status, { error, message: error })

  const issue = (_grant?: Grant): Pair => ({ refresh: token('rt'), access: token('at'), used: false })
  const tokenBody = (grant: Grant, expiresIn = 3600) => ({
    access_token: grant.current.access,
    token_type: 'Bearer',
    expires_in: expiresIn,
    refresh_token: grant.current.refresh,
    scope: grant.scopes.join(' '),
    me: state.me,
  })

  const grantForAccess = (access: string) => {
    const grant = grants.find(g => !g.revoked && g.current.access == access)
    if (grant) grant.current.used = true
    return grant
  }

  /** Whether a scope of one of `kinds` covers `path`. */
  const covers = (scopes: string[], path: string, kinds = ['write']) => scopes.some(s => {
    const i = s.indexOf(':')
    if (!kinds.includes(s.slice(0, i))) return false
    const p = decodeURIComponent(s.slice(i + 1))
    return p.endsWith('/') ? path.startsWith(p) : path == p
  })
  const isPrivate = (path: string) => /^\/(pups\/private\/|appdata\/[^/]+\/private\/[^/])/i.test(path)
  const PRIVATE = { 'Cache-Control': 'no-store', Vary: 'Authorization' }

  async function tokenEndpoint(body: URLSearchParams): Promise<Response> {
    if (body.get('grant_type') == 'authorization_code') {
      const code = codes.get(body.get('code') ?? '')
      codes.delete(body.get('code') ?? '')
      if (!code || code.clientId != body.get('client_id') || code.redirectUri != body.get('redirect_uri')
        || await sha256Base64url(body.get('code_verifier') ?? '') != code.challenge)
        return json(400, { error: 'invalid_grant' })
      const grant: Grant = { clientId: code.clientId, scopes: code.scopes, revoked: false, current: undefined! }
      grant.current = issue(grant)
      grants.push(grant)
      return json(200, tokenBody(grant, options.expiresIn))
    }
    if (body.get('grant_type') == 'refresh_token') {
      if (state.failRefreshes > 0) {
        state.failRefreshes--
        throw new TypeError('network error')
      }
      state.refreshCount++
      const refresh = body.get('refresh_token') ?? ''
      const grant = grants.find(g => g.current.refresh == refresh || g.previous?.refresh == refresh)
      if (!grant || grant.revoked) return json(400, { error: 'invalid_grant' })
      if (grant.current.refresh == refresh) {
        grant.current.used = true
        grant.previous = { refresh, replacedAt: Date.now() }
        grant.current = issue(grant)
      } else if (Date.now() - grant.previous!.replacedAt <= graceMs && !grant.current.used) {
        // Grace period: issue a fresh pair, discard the unused one.
        discarded.add(grant.current.refresh)
        discarded.add(grant.current.access)
        grant.current = issue(grant)
      } else {
        grant.revoked = true
        return json(400, { error: 'invalid_grant', error_description: 'refresh token reuse' })
      }
      const response = json(200, tokenBody(grant))
      if (state.dropNextRefreshResponse) {
        state.dropNextRefreshResponse = false
        throw new TypeError('connection reset')
      }
      return response
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  function write(method: string, path: string, headers: Headers, body: Uint8Array | undefined, auth: string | null): Response {
    const grant = auth?.startsWith('Bearer ') ? grantForAccess(auth.slice(7)) : undefined
    if (!grant) return apiError(401, 'invalid_token')
    if (path.split('/').some(s => s == '..' || s == '.')) return apiError(400, 'invalid_path')
    if (!covers(grant.scopes, path)) return apiError(403, 'insufficient_scope')
    const existing = files.get(path)
    const ifMatch = headers.get('If-Match')
    if (ifMatch && ifMatch != existing?.etag) return apiError(412, 'precondition_failed')
    if (method == 'DELETE') {
      if (!existing) return apiError(404, 'not_found')
      files.delete(path)
      return new Response(null, { status: 204 })
    }
    if (headers.get('If-None-Match') == '*' && existing) return apiError(412, 'precondition_failed')
    if (body!.byteLength > config.max_upload_bytes) return apiError(413, 'too_large')
    const etag = `"v${++etagCounter}"`
    files.set(path, { body: body!, type: headers.get('Content-Type') ?? '', etag })
    return new Response(null, { status: existing ? 200 : 201, headers: { ETag: etag } })
  }

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    state.requests.push({ method: request.method, url: url.href })
    if (url.origin != origin) throw new TypeError(`unknown host ${url.host}`)
    const path = url.pathname
    if (path == '/.well-known/host-meta.json') return json(200, hostMeta)
    if (path == '/personal-storage.json') return json(200, config)
    if (path == '/oauth/token') return tokenEndpoint(new URLSearchParams(await request.text()))
    if (path == '/oauth/revoke') {
      const t = new URLSearchParams(await request.text()).get('token')
      for (const g of grants) if (g.current.refresh == t || g.current.access == t) g.revoked = true
      return new Response(null, { status: 200 })
    }
    if (path == '/pups/host-meta') {
      const grant = grantForAccess(request.headers.get('Authorization')?.slice(7) ?? '')
      if (!grant) return apiError(401, 'invalid_token')
      const body = await request.json() as Record<string, any>
      if (body.action == 'add') {
        hostMeta.links = hostMeta.links.filter(l => l.rel != body.rel || l.href != body.href)
        hostMeta.links.push({ rel: body.rel, href: body.href, type: body.type, ...body.titles && { titles: body.titles },
          properties: { ...body.properties, 'https://bigwide.net/ns/pups#client': grant.clientId } })
        return json(201, {})
      }
      if (body.action == 'order') {
        const others = hostMeta.links.filter(l => l.rel != body.rel)
        const mine = (body.hrefs as string[]).map(h => hostMeta.links.find(l => l.rel == body.rel && l.href == h))
        if (mine.some(l => !l) || mine.length != hostMeta.links.length - others.length) return apiError(409, 'conflict')
        hostMeta.links = [...others, ...mine as Record<string, unknown>[]]
        return new Response(null, { status: 204 })
      }
      if (body.action == 'remove') {
        hostMeta.links = hostMeta.links.filter(l => l.rel != body.rel || l.href != body.href)
        return new Response(null, { status: 204 })
      }
      hostMeta.properties[body.property!] = body.value!
      return json(201, {})
    }
    if (path == '/pups/post' && options.postFallback) {
      const target = url.searchParams.get('path') ?? ''
      const body = new Uint8Array(await request.arrayBuffer())
      return write(url.searchParams.get('method')!, target, request.headers, body, request.headers.get('Authorization'))
    }
    if (path.startsWith('/files/')) {
      const filePath = decodeURIComponent(path.slice('/files'.length))
      if (request.method == 'GET' || request.method == 'HEAD') {
        const auth = request.headers.get('Authorization')
        const priv = isPrivate(filePath)
        // Private files: decided before looking for the file, and never cached (RFC-6 "Private areas").
        if (priv && !auth) return json(401, { error: 'invalid_token' }, { ...PRIVATE, 'WWW-Authenticate': 'Bearer' })
        // A fresh read (RFC-6 "Fresh reads"): any valid token, the latest version, never cached.
        const grant = auth ? grantForAccess(auth.slice(7)) : undefined
        if (auth && !grant)
          return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"', ...priv && PRIVATE } })
        if (priv && !covers(grant!.scopes, filePath, ['write', 'read'])) return json(403, { error: 'insufficient_scope' }, PRIVATE)
        if (priv && !files.has(filePath)) return json(404, { error: 'not_found' }, PRIVATE)
        let file = files.get(filePath)
        if (!auth && state.cachePublicReads && file) file = cached.get(filePath) ?? cached.set(filePath, file).get(filePath)
        if (!file) return apiError(404, 'not_found')
        const cacheControl = auth ? 'private, no-store' : 'no-cache'
        return new Response(file.body.slice(), { status: 200, headers: { ETag: file.etag, 'Content-Type': file.type, 'Cache-Control': cacheControl, Vary: 'Authorization' } })
      }
      if (options.postFallback) return new Response('blocked by WAF', { status: 405 })
      const body = request.method == 'PUT' ? new Uint8Array(await request.arrayBuffer()) : undefined
      return write(request.method, filePath, request.headers, body, request.headers.get('Authorization'))
    }
    return new Response('not found', { status: 404 })
  }

  /**
   * Simulates the owner's consent: returns the redirect to the app's redirect URI.
   * `grant` narrows the scopes, `deny` denies, `iss` overrides the issuer in the response.
   */
  function authorize(authUrl: string, consent: { grant?: string[]; deny?: boolean; iss?: string } = {}): string {
    const params = new URL(authUrl).searchParams
    const redirect = new URL(params.get('redirect_uri')!)
    redirect.searchParams.set('state', params.get('state')!)
    redirect.searchParams.set('iss', consent.iss ?? origin)
    if (consent.deny) {
      redirect.searchParams.set('error', 'access_denied')
      return redirect.href
    }
    const code = token('code')
    codes.set(code, {
      clientId: params.get('client_id')!,
      redirectUri: params.get('redirect_uri')!,
      challenge: params.get('code_challenge')!,
      scopes: consent.grant ?? params.get('scope')!.split(' '),
    })
    redirect.searchParams.set('code', code)
    return redirect.href
  }

  return { fetch: fetchFn, authorize, state, origin }
}
