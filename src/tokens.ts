import { normalizeDomain } from './discovery.js'
import { PupsError } from './errors.js'
import { tokenRequest } from './oauth.js'
import type { SessionRecord, TokenStore } from './store/token-store.js'
import { withLock, type TabChannel } from './tabs.js'
import { sleep } from './util.js'

/**
 * Timing of token handling. Exported for tests; apps should not change it.
 * @internal
 */
export const timing = {
  /** Delays before the retries of a failed refresh. All retries start within the 60-second grace period of RFC-6. */
  refreshRetryDelaysMs: [1_000, 4_000, 15_000],
  /** No refresh attempt starts later than this after the first one. */
  lastRetryStartMs: 45_000,
  /** An access token counts as expired this long before `expires_in` ends, to absorb clock skew. */
  expirySkewMs: 60_000,
}

/** When an access token issued now with `expiresIn` seconds should be treated as expired. */
export const accessTokenExpiry = (now: number, expiresIn: number) =>
  now + expiresIn * 1000 - Math.min(timing.expirySkewMs, expiresIn * 500)

/** The Web Lock that serializes refreshes of one session across all tabs. */
export const refreshLockName = (clientId: string, me: string) => `pups-client:refresh:${clientId}:${me}`

const ended = () => new PupsError('session_expired', 'The session has ended. Log in again.')

export interface TokenManagerContext {
  fetch: typeof fetch
  store: TokenStore
  channel: TabChannel
  /** Called once when the session ends in this tab through expiry. */
  onExpired(error: PupsError): void
}

/**
 * Owns the tokens of one session in this tab: hands out valid access tokens, refreshes them, and keeps the store
 * and the other tabs in sync.
 *
 * Invariant: a record is written to the store only while holding the refresh lock, and only after rereading the
 * store under that lock. Otherwise a tab could write back an older refresh token, whose later use would make the
 * server revoke the whole grant (RFC-6 "Refresh").
 * @internal
 */
export class TokenManager {
  readonly #ctx: TokenManagerContext
  readonly #lockName: string
  #record?: SessionRecord
  /** The last known record, kept after the session ended so that `me` and `server` stay readable. */
  #last: SessionRecord
  #persistent: boolean

  constructor(record: SessionRecord, persistent: boolean, ctx: TokenManagerContext) {
    this.#record = this.#last = record
    this.#persistent = persistent
    this.#ctx = ctx
    this.#lockName = refreshLockName(record.clientId, record.me)
  }

  get record(): SessionRecord {
    return this.#last
  }

  get active() {
    return !!this.#record
  }

  get persistent() {
    return this.#persistent
  }

  /**
   * A valid access token. Refreshes if the current one has expired, or if it is `stale` (the server rejected it).
   * @throws {PupsError} `session_expired` if the session can't be renewed; retryable errors if the server can't be reached.
   */
  async accessToken(stale?: string): Promise<string> {
    const usable = (r: SessionRecord) => r.accessToken != stale && r.accessTokenExpiresAt > Date.now()
    if (!this.#record) throw ended()
    if (usable(this.#record)) return this.#record.accessToken
    return withLock(this.#lockName, async () => {
      let record = this.#record
      if (!record) throw ended()
      if (this.#persistent) {
        // Another tab may have refreshed, logged out or logged in again meanwhile.
        const stored = await this.#ctx.store.get(record.clientId, record.me)
        if (!stored) return this.#expire(new PupsError('session_expired', 'The session was ended in another tab or its data was removed. Log in again.'), false)
        record = this.#setRecord(stored)
      }
      if (usable(record)) return record.accessToken
      if (!record.refreshToken)
        return this.#expire(new PupsError('session_expired', 'The access token expired, and the server issued no refresh token. Log in again.'))
      let tokens
      try {
        tokens = await this.#refreshWithRetries(record)
      } catch (e) {
        if (e instanceof PupsError && e.code == 'session_expired') return this.#expire(e)
        throw e
      }
      if (normalizeDomain(tokens.me) != record.me)
        return this.#expire(new PupsError('identity_mismatch', `The server now names "${tokens.me}" as the identity instead of "${record.me}". Log in again.`))
      const now = Date.now()
      const next: SessionRecord = {
        ...record,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: accessTokenExpiry(now, tokens.expiresIn),
        refreshToken: tokens.refreshToken ?? record.refreshToken,
        scopes: tokens.scopes ?? record.scopes,
        lastUsedAt: now,
      }
      this.#setRecord(next)
      if (this.#persistent) {
        // Store before use: if the new refresh token isn't stored, no tab may later send the replaced one.
        try {
          await this.#ctx.store.put(next)
          this.#ctx.channel.post({ type: 'tokens', me: next.me })
        } catch {
          await this.#ctx.store.delete(next.clientId, next.me).catch(() => {})
          this.#persistent = false
        }
      }
      return next.accessToken
    })
  }

  /** Rereads the record after another tab changed it. */
  async reload(): Promise<void> {
    if (!this.#record || !this.#persistent) return
    const stored = await this.#ctx.store.get(this.#record.clientId, this.#record.me)
    if (stored && this.#record) this.#setRecord(stored)
  }

  /** Ends the session in this tab without touching the store, e.g. after a logout in another tab. */
  end(): void {
    this.#record = undefined
  }

  /**
   * Ends the session for logout: under the refresh lock, reads the newest record, deletes it from the store and
   * returns it, so that its tokens can be revoked.
   */
  takeForLogout(): Promise<SessionRecord | undefined> {
    return withLock(this.#lockName, async () => {
      let record = this.#record
      if (!record) return
      if (this.#persistent) {
        record = await this.#ctx.store.get(record.clientId, record.me).catch(() => undefined) ?? record
        await this.#ctx.store.delete(record.clientId, record.me)
      }
      this.#record = undefined
      return record
    })
  }

  /** Changes the pinned server configuration (same issuer) under the refresh lock. */
  updateServer(server: SessionRecord['server']): Promise<void> {
    return withLock(this.#lockName, async () => {
      let record = this.#record
      if (!record) throw ended()
      if (this.#persistent) record = await this.#ctx.store.get(record.clientId, record.me) ?? record
      const next = this.#setRecord({ ...record, server })
      if (this.#persistent) await this.#ctx.store.put(next)
      this.#ctx.channel.post({ type: 'tokens', me: next.me })
    })
  }

  #setRecord(record: SessionRecord) {
    return this.#record = this.#last = record
  }

  /**
   * Refreshes, retrying promptly on network errors, `429` and `5xx` with the same refresh token. RFC-6 keeps a
   * replaced refresh token usable for at least 60 seconds while nothing issued by its replacement was used, so a
   * retry after a lost response succeeds instead of revoking the grant.
   */
  async #refreshWithRetries(record: SessionRecord) {
    const start = Date.now()
    let lastError: unknown
    for (const delay of [0, ...timing.refreshRetryDelaysMs]) {
      if (delay) {
        if (Date.now() - start + delay > timing.lastRetryStartMs) break
        await sleep(delay)
      }
      try {
        return await tokenRequest(this.#ctx.fetch, record.server, {
          grant_type: 'refresh_token',
          refresh_token: record.refreshToken!,
          client_id: record.clientId,
        }, 'refresh')
      } catch (e) {
        if (!(e instanceof PupsError) || !e.retryable) throw e
        lastError = e
      }
    }
    throw lastError
  }

  async #expire(error: PupsError, deleteStored = true): Promise<never> {
    const record = this.#record
    this.#record = undefined
    if (record) {
      if (this.#persistent && deleteStored) await this.#ctx.store.delete(record.clientId, record.me).catch(() => {})
      this.#ctx.onExpired(error)
    }
    throw error
  }
}
