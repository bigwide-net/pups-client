import { discover, normalizeDomain, type PupsServer } from './discovery.js'
import { PupsError } from './errors.js'
import { authorizationUrl, callbackParamNames, createPkce, parseCallback, revokeToken, tokenRequest, verifyMe, type CallbackParams } from './oauth.js'
import { expandScopes, validateScopes, type Scope } from './scopes.js'
import { PupsSession, type SessionChangeEvent } from './session.js'
import { IndexedDbTokenStore } from './store/indexeddb-store.js'
import { MemoryTokenStore } from './store/memory-store.js'
import type { SessionRecord, TokenStore } from './store/token-store.js'
import { TabChannel, withLock, type TabMessage } from './tabs.js'
import { accessTokenExpiry, refreshLockName } from './tokens.js'
import { abortError, fetchWithTimeout, isLoopbackHost, isSameHostOrWww, parseUrl, randomString } from './util.js'

export interface PupsClientOptions {
  /** The app's `client_id`: the HTTPS URL of its client metadata document, on the app's own domain. */
  clientId: string
  /**
   * Where the server sends the authorization response. Must be listed in the client metadata document, exactly.
   * HTTPS, or `http://127.0.0.1` / `http://[::1]` with any port for native apps and local development.
   */
  redirectUri: string
  /** Where sessions are kept. Default: {@link IndexedDbTokenStore} in browsers, {@link MemoryTokenStore} elsewhere. */
  store?: TokenStore
  /** The `fetch` to use, for tests and instrumentation. Default: the global `fetch`. */
  fetch?: typeof fetch
}

export interface LoginOptions {
  /** The scopes to request. Default: `['appdata']`. The owner may grant fewer; check `session.scopes`. */
  scopes?: Scope[]
  /** Any JSON-serializable value, returned by `handleRedirect()` after the redirect, e.g. the page to return to. */
  appState?: unknown
  /** Whether to store the session. Default true; false keeps it in this tab's memory only. */
  persist?: boolean
}

export interface PopupLoginOptions extends LoginOptions {
  /** How long to wait for the owner. Default: 5 minutes. */
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * A started authorization, for {@link PupsClient.completeAuthorization}. Contains the PKCE verifier: keep it in
 * memory or `sessionStorage`, never send it anywhere but to your own backend.
 */
export interface PendingAuthorization {
  /** Open this URL in the browser. */
  url: string
  state: string
  codeVerifier: string
  server: PupsServer
  /** The requested scopes, expanded. */
  scopes: string[]
  redirectUri: string
  appState?: unknown
  persist: boolean
  createdAt: number
}

/** An authorization code for the app's backend to redeem (see "Sign-in through the app's backend"). */
export interface AuthorizationCode {
  code: string
  codeVerifier: string
  redirectUri: string
  clientId: string
  issuer: string
  tokenEndpoint: string
  /** `me` in the token response must name one of these hosts, or lead to the same issuer by discovery. */
  identityHosts: string[]
}

export interface RedirectResult {
  /** The new session. Absent with `redeem: false`, and in the popup window. */
  session?: PupsSession
  appState?: unknown
  /** Only with `redeem: false`. */
  code?: AuthorizationCode
}

export interface ClientMetadataReport {
  ok: boolean
  /** Everything a PUPS server would reject, in plain words. */
  problems: string[]
  document?: unknown
}

const pendingPrefix = 'pups-client:pending:'
const pendingMaxAgeMs = 10 * 60 * 1000
const defaultPopupTimeoutMs = 5 * 60 * 1000

/**
 * The entry point of pups-client. Create one per app and reuse it.
 *
 * ```ts
 * const pups = new PupsClient({ clientId: 'https://app.example/oauth/client.json', redirectUri: 'https://app.example/callback' })
 * const session = await pups.init() ?? await pups.login('tim.example.com', { scopes: ['appdata'] })
 * ```
 */
export class PupsClient {
  readonly clientId: string
  readonly redirectUri: string
  readonly #store: TokenStore
  readonly #fetch: typeof fetch
  readonly #channel: TabChannel
  readonly #listeners = new Set<(event: SessionChangeEvent) => void>()
  /** Sessions of this tab, by `me`, so that changes from other tabs reach them. */
  readonly #sessions = new Map<string, PupsSession>()
  readonly #popupWaiters = new Map<string, (params: CallbackParams) => void>()

  constructor(options: PupsClientOptions) {
    this.clientId = checkClientId(options.clientId)
    this.redirectUri = checkRedirectUri(options.redirectUri)
    this.#store = options.store ?? (typeof indexedDB == 'undefined' ? new MemoryTokenStore() : new IndexedDbTokenStore())
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#channel = new TabChannel(`pups-client:${this.clientId}`)
    this.#channel.subscribe(message => this.#onTabMessage(message))
  }

  /** Finds the PUPS server of a domain. Use it to check what a server offers before asking for scopes. */
  discover(domain: string, options: { signal?: AbortSignal } = {}): Promise<PupsServer> {
    return discover(domain, this.#fetch, options.signal)
  }

  /**
   * Starts authorization with a full-page redirect. The promise never resolves: the page navigates away, and the
   * session arrives through `init()` or `handleRedirect()` on the redirect URI page.
   */
  async login(domain: string | PupsServer, options: LoginOptions = {}): Promise<never> {
    const pending = await this.createAuthorization(domain, options)
    removeOldPending()
    try {
      sessionStorage.setItem(pendingPrefix + pending.state, JSON.stringify(pending))
    } catch (e) {
      throw new PupsError('authorization_failed', 'Could not save the login request in sessionStorage.', { cause: e })
    }
    location.assign(pending.url)
    return new Promise<never>(() => {})
  }

  /**
   * Starts authorization in a popup and resolves with the session. Call it directly in a click handler, before any
   * `await`, or the browser blocks the popup.
   * @throws {PupsError} `popup_blocked` (fall back to `login()`), `popup_timeout`, `aborted`, and the errors of `handleRedirect()`.
   */
  async loginWithPopup(domain: string | PupsServer, options: PopupLoginOptions = {}): Promise<PupsSession> {
    // Opened before the first await, while the user gesture still counts.
    const popup = window.open('', 'pups-login', 'popup,width=480,height=720')
    if (!popup) throw new PupsError('popup_blocked', 'The browser blocked the login popup. Use login() instead.')
    let state: string | undefined
    try {
      if (options.signal?.aborted) throw abortError()
      const pending = await this.#createAuthorization(domain, options, 'p', options.signal)
      state = pending.state
      const params = this.#waitForPopup(pending.state, options)
      popup.location.href = pending.url
      return (await this.#complete(await params, pending, true)).session!
    } catch (e) {
      if (state) this.#popupWaiters.delete(state)
      popup.close()
      throw e
    }
  }

  /**
   * Completes authorization on the redirect URI page. Returns undefined if the URL is not an authorization
   * response, so it is safe to call on every page load. In the login popup, it hands the response to the opening
   * tab and closes the window.
   *
   * With `redeem: false` the code is returned instead of redeemed, for the app's backend to redeem.
   * @throws {PupsError} `access_denied`, `state_mismatch`, `issuer_mismatch`, `identity_mismatch`, `authorization_failed`
   */
  async handleRedirect(options: { url?: string; redeem?: boolean } = {}): Promise<RedirectResult | undefined> {
    const current = typeof location == 'undefined' ? undefined : location.href
    const url = options.url ?? current
    const params = url && parseCallback(url)
    if (!params) return
    if (url == current) removeCallbackParams()
    if (params.state.startsWith('p.')) {
      this.#channel.post({ type: 'callback', params })
      setTimeout(() => window.close(), 50)
      return {}
    }
    const key = pendingPrefix + params.state
    const stored = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    if (!stored) throw new PupsError('state_mismatch', 'This login response doesn\'t belong to a login started in this tab. Start the login again.')
    return this.#complete(params, JSON.parse(stored), options.redeem ?? true)
  }

  /**
   * `handleRedirect()` if the URL is an authorization response, otherwise `restore()`. The usual call on page load.
   */
  async init(): Promise<PupsSession | undefined> {
    const result = await this.handleRedirect()
    return result ? result.session : this.restore()
  }

  /**
   * Starts an authorization without navigating anywhere: discovers the server if needed, checks the scopes, and
   * creates the authorization URL. For native apps (open `url` in the system browser, receive the redirect on a
   * loopback port) and custom flows. Finish with {@link completeAuthorization}.
   */
  createAuthorization(domain: string | PupsServer, options: LoginOptions & { signal?: AbortSignal } = {}): Promise<PendingAuthorization> {
    return this.#createAuthorization(domain, options, 'r', options.signal)
  }

  /**
   * Finishes an authorization started with {@link createAuthorization}: checks `state` and `iss`, redeems the code,
   * verifies `me`, and stores the session.
   * @param callbackUrl The URL the server redirected to, with `code`, `state` and `iss`.
   */
  async completeAuthorization(callbackUrl: string, pending: PendingAuthorization, options: { redeem?: boolean } = {}): Promise<RedirectResult> {
    const params = parseCallback(callbackUrl)
    if (!params || params.state != pending.state)
      throw new PupsError('state_mismatch', 'The authorization response doesn\'t belong to this authorization request.')
    return this.#complete(params, pending, options.redeem ?? true)
  }

  /** The stored session for `me`, or the most recently used one. */
  async restore(me?: string): Promise<PupsSession | undefined> {
    const normalized = me === undefined ? undefined : normalizeDomain(me)
    const live = normalized && this.#sessions.get(normalized)
    if (live && live.active) return live
    const records = normalized
      ? [await this.#store.get(this.clientId, normalized)].filter((r): r is SessionRecord => !!r)
      : await this.#store.list(this.clientId)
    const record = records.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    return record && this.#sessionFor(record)
  }

  /** All stored sessions of this client, one per connected domain. */
  async sessions(): Promise<PupsSession[]> {
    const records = await this.#store.list(this.clientId)
    return records.sort((a, b) => b.lastUsedAt - a.lastUsedAt).map(r => this.#sessionFor(r))
  }

  /**
   * Calls `listener` on login, logout and expiry, also when they happen in another tab.
   * @returns a function that unsubscribes.
   */
  onSessionChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Development helper: fetches the client metadata document and reports what a PUPS server would reject.
   * In browsers this needs CORS on the document; a failed fetch is reported as a problem.
   */
  async checkClientMetadata(): Promise<ClientMetadataReport> {
    const problems: string[] = []
    let document: unknown
    try {
      const response = await fetchWithTimeout(this.#fetch, this.clientId, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } }, 10_000)
      if (!response.ok) problems.push(`${this.clientId} answered HTTP ${response.status}.`)
      else document = await response.json()
    } catch (e) {
      problems.push(`${this.clientId} can't be fetched or is not JSON: ${(e as Error).message}`)
    }
    if (document !== undefined) problems.push(...clientMetadataProblems(document, this.clientId, this.redirectUri))
    return { ok: !problems.length, problems, ...document === undefined ? {} : { document } }
  }

  /** Closes the channel to other tabs. Only needed where a client is created and discarded, e.g. in tests or a CLI. */
  close(): void {
    this.#channel.close()
  }

  async #createAuthorization(domain: string | PupsServer, options: LoginOptions, mode: 'r' | 'p', signal?: AbortSignal): Promise<PendingAuthorization> {
    const server = typeof domain == 'string' ? await this.discover(domain, { signal }) : domain
    const scopes = expandScopes(options.scopes ?? ['appdata'], this.clientId)
    validateScopes(scopes, server, this.clientId)
    const { verifier, challenge } = await createPkce()
    const state = `${mode}.${randomString(32)}`
    return {
      url: authorizationUrl(server, { clientId: this.clientId, redirectUri: this.redirectUri, scopes, state, codeChallenge: challenge }),
      state,
      codeVerifier: verifier,
      server,
      scopes,
      redirectUri: this.redirectUri,
      ...options.appState === undefined ? {} : { appState: options.appState },
      persist: options.persist ?? true,
      createdAt: Date.now(),
    }
  }

  #waitForPopup(state: string, options: PopupLoginOptions): Promise<CallbackParams> {
    return new Promise((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.#popupWaiters.delete(state)
        settle()
      }
      const timer = setTimeout(() => finish(() => reject(new PupsError('popup_timeout', 'The login was not completed in time.'))), options.timeoutMs ?? defaultPopupTimeoutMs)
      const onAbort = () => finish(() => reject(abortError()))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.#popupWaiters.set(state, params => finish(() => resolve(params)))
    })
  }

  /** Checks the authorization response, redeems the code, verifies `me`, stores and returns the session. */
  async #complete(params: CallbackParams, pending: PendingAuthorization, redeem: boolean): Promise<RedirectResult> {
    const { server } = pending
    if (Date.now() - pending.createdAt > pendingMaxAgeMs)
      throw new PupsError('authorization_failed', 'The login took longer than 10 minutes. Start it again.')
    if (params.error) {
      const description = params.errorDescription ? `: ${params.errorDescription}` : ''
      if (params.error == 'access_denied') throw new PupsError('access_denied', `The owner of ${new URL(server.domain).host} denied the request${description}.`, { serverMessage: params.errorDescription })
      throw new PupsError(params.error == 'invalid_scope' ? 'invalid_scope' : 'authorization_failed', `Authorization failed: ${params.error}${description}`, { serverMessage: params.errorDescription })
    }
    // RFC 9207: check the issuer before redeeming the code, against mix-up attacks.
    if (params.iss != server.issuer)
      throw new PupsError('issuer_mismatch', `The authorization response comes from "${params.iss ?? 'an unnamed issuer'}", not from ${server.issuer}. The code was not used.`)
    if (!params.code) throw new PupsError('authorization_failed', 'The authorization response has no code.')
    if (!redeem) return {
      ...pending.appState === undefined ? {} : { appState: pending.appState },
      code: {
        code: params.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
        clientId: this.clientId,
        issuer: server.issuer,
        tokenEndpoint: server.tokenEndpoint,
        identityHosts: server.identityHosts,
      },
    }

    const tokens = await tokenRequest(this.#fetch, server, {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: this.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    }, 'code')
    let me: string
    try {
      me = await verifyMe(this.#fetch, tokens.me, server)
    } catch (e) {
      // Tokens for an identity we can't confirm are worthless; end the grant.
      if (tokens.refreshToken) await revokeToken(this.#fetch, server, this.clientId, tokens.refreshToken, 'refresh_token')
      await revokeToken(this.#fetch, server, this.clientId, tokens.accessToken, 'access_token')
      throw e
    }
    const scopes = tokens.scopes ?? pending.scopes
    if (!scopes.length) throw new PupsError('access_denied', 'The owner granted no scopes.')

    const now = Date.now()
    const record: SessionRecord = {
      clientId: this.clientId,
      me,
      server,
      scopes,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: accessTokenExpiry(now, tokens.expiresIn),
      ...tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {},
      createdAt: now,
      lastUsedAt: now,
    }
    let persistent = pending.persist
    if (persistent) {
      try {
        // Under the refresh lock, so that a refresh of an older session for `me` in another tab can't overwrite it.
        await withLock(refreshLockName(this.clientId, me), () => this.#store.put(record))
      } catch {
        persistent = false
      }
    }
    this.#sessions.get(me)?._tokens.end()
    const session = this.#createSession(record, persistent)
    if (persistent) this.#channel.post({ type: 'login', me })
    this.#emit({ type: 'login', me })
    return { session, ...pending.appState === undefined ? {} : { appState: pending.appState } }
  }

  #sessionFor(record: SessionRecord): PupsSession {
    const live = this.#sessions.get(record.me)
    return live && live.active ? live : this.#createSession(record, true)
  }

  #createSession(record: SessionRecord, persistent: boolean): PupsSession {
    const session = new PupsSession(record, persistent, {
      fetch: this.#fetch,
      store: this.#store,
      channel: this.#channel,
      ended: (s, event) => this.#sessionEnded(s, event),
    })
    if (persistent) this.#sessions.set(record.me, session)
    return session
  }

  #sessionEnded(session: PupsSession, event: SessionChangeEvent) {
    if (this.#sessions.get(session.me) == session) this.#sessions.delete(session.me)
    if (session.persistent)
      this.#channel.post(event.type == 'expired' ? { type: 'expired', me: event.me, message: event.error.message } : { type: 'logout', me: event.me })
    this.#emit(event)
  }

  #onTabMessage(message: TabMessage) {
    if (message.type == 'callback') return this.#popupWaiters.get(message.params.state)?.(message.params)
    const session = this.#sessions.get(message.me)
    switch (message.type) {
      case 'tokens':
        return void session?._tokens.reload()
      case 'login':
        void session?._tokens.reload()
        return this.#emit({ type: 'login', me: message.me })
      case 'logout':
      case 'expired':
        session?._tokens.end()
        this.#sessions.delete(message.me)
        return this.#emit(message.type == 'expired'
          ? { type: 'expired', me: message.me, error: new PupsError('session_expired', message.message) }
          : { type: 'logout', me: message.me })
    }
  }

  #emit(event: SessionChangeEvent) {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (e) {
        // One failing listener must not keep the others from being called.
        setTimeout(() => { throw e })
      }
    }
  }
}

function checkClientId(clientId: string): string {
  const url = parseUrl(clientId)
  if (!url || url.protocol != 'https:' || url.pathname == '/' || url.port || url.search || url.hash || url.username || url.password)
    throw new PupsError('invalid_request', `clientId "${clientId}" must be an HTTPS URL with a path and without port, query or fragment, e.g. https://app.example/oauth/client.json (RFC-6, Client identity).`)
  return url.href
}

function checkRedirectUri(redirectUri: string): string {
  const url = parseUrl(redirectUri)
  const ok = url && !url.hash && (url.protocol == 'https:' || (url.protocol == 'http:' && isLoopbackHost(url.hostname)))
  if (!ok)
    throw new PupsError('invalid_request', `redirectUri "${redirectUri}" must be an HTTPS URL, or http://127.0.0.1 or http://[::1] with any port. "localhost" is not accepted (RFC-6, Client identity).`)
  return redirectUri
}

/** Compares redirect URIs as RFC-6 does: exactly, except for the port of loopback URIs. */
function sameRedirectUri(listed: string, actual: string): boolean {
  if (listed == actual) return true
  const a = parseUrl(listed)
  const b = parseUrl(actual)
  if (!a || !b || a.protocol != 'http:' || !isLoopbackHost(a.hostname)) return false
  a.port = b.port = ''
  return a.href == b.href
}

/** The problems a PUPS server would find in a client metadata document. */
export function clientMetadataProblems(document: unknown, clientId: string, redirectUri: string): string[] {
  const problems: string[] = []
  const doc = (document && typeof document == 'object' ? document : {}) as Record<string, unknown>
  const clientHost = new URL(clientId).hostname
  if (doc.client_id != clientId) problems.push(`"client_id" must be exactly "${clientId}", the URL the document is served from.`)
  const redirects = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u == 'string') : []
  if (!redirects.some(u => sameRedirectUri(u, redirectUri))) problems.push(`"redirect_uris" doesn't list "${redirectUri}".`)
  for (const uri of redirects) {
    const url = parseUrl(uri)
    if (url?.hostname == 'localhost') problems.push(`Redirect URI "${uri}": "localhost" is not accepted; use http://127.0.0.1.`)
    else if (url?.protocol == 'http:' && !isLoopbackHost(url.hostname)) problems.push(`Redirect URI "${uri}": plain HTTP is only allowed for 127.0.0.1 and [::1].`)
  }
  for (const field of ['client_uri', 'logo_uri']) {
    if (doc[field] === undefined) continue
    const url = parseUrl(doc[field])
    if (!url || !isSameHostOrWww(url.hostname, clientHost))
      problems.push(`"${field}" must be on ${clientHost} (a "www." difference is allowed), not on another host or a parent domain.`)
  }
  return problems
}

/** Removes the authorization response from the address bar, so the code doesn't stay in history or bookmarks. */
function removeCallbackParams() {
  const url = new URL(location.href)
  for (const name of callbackParamNames) url.searchParams.delete(name)
  history.replaceState(history.state, '', url.href)
}

function removeOldPending() {
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i)
    if (!key?.startsWith(pendingPrefix)) continue
    try {
      if (Date.now() - JSON.parse(sessionStorage.getItem(key)!).createdAt <= pendingMaxAgeMs) continue
    } catch {
      // Unreadable: remove.
    }
    sessionStorage.removeItem(key)
  }
}
