import type { PupsServer } from '../discovery.js'

/**
 * Everything the library keeps about one connected domain. Contains the tokens: store it only through a
 * {@link TokenStore}, never log it.
 */
export interface SessionRecord {
  clientId: string
  /** The verified identity, `https://<host>/`. Together with `clientId` the key of the record. */
  me: string
  /** The server configuration, pinned at login so that a changed `host-meta.json` can't redirect the tokens. */
  server: PupsServer
  /** The granted scopes. */
  scopes: string[]
  accessToken: string
  /** Milliseconds since the epoch, with a safety margin for clock skew already subtracted. */
  accessTokenExpiresAt: number
  refreshToken?: string
  createdAt: number
  /** Updated at login and at every refresh. */
  lastUsedAt: number
}

/**
 * Persistence for session records.
 *
 * A store must be shared by all tabs of the origin, like IndexedDB is; otherwise the cross-tab refresh protection
 * doesn't work, and two tabs could use the same refresh token. Implementations must not log records.
 */
export interface TokenStore {
  get(clientId: string, me: string): Promise<SessionRecord | undefined>
  /** All records of a client. */
  list(clientId: string): Promise<SessionRecord[]>
  put(record: SessionRecord): Promise<void>
  delete(clientId: string, me: string): Promise<void>
}
