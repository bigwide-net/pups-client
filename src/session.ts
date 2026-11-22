import { discover, type PupsServer } from './discovery.js'
import { errorFromResponse, isPupsError, PupsError } from './errors.js'
import { listFeeds, PupsFeed, type FeedLink, type FeedOptions } from './feed.js'
import { fileTypeOf, uploadContentType } from './file-types.js'
import { HostMetaEditor } from './host-meta.js'
import { Mentions } from './mentions.js'
import { revokeToken } from './oauth.js'
import { isPrivate, publicUrl, resolvePath, scopeCovers, storageUrl, validatePath } from './paths.js'
import {
  appDataPathOf, clientHostOf, expandScopes, readScopePath, readScopePaths, scopesAllowReading, scopesCoverPath, writeScopePath,
  writeScopePaths, type Scope,
} from './scopes.js'
import type { SessionRecord, TokenStore } from './store/token-store.js'
import type { TabChannel } from './tabs.js'
import { TokenManager } from './tokens.js'
import { fetchWithTimeout } from './util.js'

const readTimeoutMs = 30_000
const writeTimeoutMs = 300_000

/** A JSON value that the library serializes with `JSON.stringify`, allowed only for `.json` paths. */
export type JsonBody = object | number | boolean | null

/**
 * A file body. Strings are sent as UTF-8; objects, arrays, numbers, booleans and `null` as JSON (`.json` only);
 * `Blob`, `ArrayBuffer` and typed arrays as they are. Streams are not accepted, because a body must be replayable:
 * the library repeats a request once after renewing an expired token.
 */
export type Body = string | Blob | ArrayBuffer | ArrayBufferView | JsonBody

export interface WriteOptions {
  /**
   * The `Content-Type` to upload with. It must be accepted for the file's extension, e.g. `application/feed+json`
   * for `.json`. Default: the type the extension is served as.
   */
  contentType?: string
  signal?: AbortSignal
}

export interface WriteResult {
  /** The absolute, normalized path. */
  path: string
  /** The new ETag, for a later `replace()` or `delete()`. */
  etag: string
  /** The public URL readers use; absent for a private file, which has none. */
  url?: string
  /** Whether the file was created (`201`) rather than replaced (`200`). */
  created: boolean
}

/** A file read from `storage_base`. */
export interface StoredFile {
  path: string
  /** The ETag to pass to `replace()`; empty if the server doesn't expose it. */
  etag: string
  contentType: string
  size: number
  lastModified?: Date
  blob(): Promise<Blob>
  /** The content decoded as UTF-8. */
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

export type SessionChangeEvent =
  | { type: 'login'; me: string }
  | { type: 'logout'; me: string }
  /** The session ended without logout: the grant was revoked, or the refresh token expired. */
  | { type: 'expired'; me: string; error: PupsError }

/** @internal */
export interface SessionContext {
  fetch: typeof fetch
  store: TokenStore
  channel: TabChannel
  ended(session: PupsSession, event: SessionChangeEvent): void
}

/**
 * A connection to one owner's PUPS server, with the granted scopes. Get one from `PupsClient.init()`, `login()`,
 * `loginWithPopup()` or `restore()`; don't construct it yourself.
 *
 * Paths: a path starting with `/` is absolute, relative to `storage_base`. Any other path is relative to the app's
 * own directory: `put('comments.json', …)` writes `/appdata/<client-host>/comments.json`.
 */
export class PupsSession {
  /** The verified identity of the owner, `https://<host>/`. Key accounts on this. */
  readonly me: string
  /** The `client_id` of the app. */
  readonly clientId: string
  /** The host of the `client_id`. */
  readonly clientHost: string
  /** The app's own directory, `/appdata/<client-host>/`. */
  readonly appDataPath: string
  /**
   * The app's private folder, `/appdata/<client-host>/private/` (RFC-6 "Private areas"). Only this app can read the
   * files in it; relative paths starting with `private/` are in it.
   */
  readonly privatePath: string
  /** Edits `host-meta.json` through the server's host-meta endpoint. */
  readonly hostMeta: HostMetaEditor
  #mentions?: Mentions
  /** @internal */
  readonly _tokens: TokenManager
  readonly #ctx: SessionContext

  /** @internal */
  constructor(record: SessionRecord, persistent: boolean, ctx: SessionContext) {
    this.me = record.me
    this.clientId = record.clientId
    this.clientHost = clientHostOf(record.clientId)
    this.appDataPath = appDataPathOf(record.clientId)
    this.privatePath = `${this.appDataPath}private/`
    this.#ctx = ctx
    this._tokens = new TokenManager(record, persistent, {
      fetch: ctx.fetch,
      store: ctx.store,
      channel: ctx.channel,
      onExpired: error => ctx.ended(this, { type: 'expired', me: this.me, error }),
    })
    this.hostMeta = new HostMetaEditor(this, ctx.fetch)
  }

  /**
   * Sends webmentions: RFC-11 mentions to domains, RFC-4 submissions to feeds. Shared by the session's feeds, so
   * that they share the discovery cache.
   */
  get mentions(): Mentions {
    return this.#mentions ??= new Mentions({ fetch: this.#ctx.fetch, me: this.me })
  }

  /** The server configuration, pinned at login. */
  get server(): PupsServer {
    return this._tokens.record.server
  }

  /** The issuer of the server. */
  get issuer(): string {
    return this.server.issuer
  }

  /** The granted scopes. The owner may have granted fewer than requested. */
  get scopes(): readonly string[] {
    return this._tokens.record.scopes
  }

  /** Whether the session survives a reload (stored), or lives only in this tab's memory. */
  get persistent(): boolean {
    return this._tokens.persistent
  }

  /** False after logout, expiry, or logout in another tab. */
  get active(): boolean {
    return this._tokens.active
  }

  /**
   * Whether a scope was granted. A directory scope also counts as granted if a parent directory was granted, and a
   * `read:` scope also if a `write:` scope covers it, since that allows reading too.
   */
  hasScope(scope: Scope): boolean {
    const [expanded] = expandScopes([scope], this.clientId)
    if (expanded == 'identify') return this.scopes.includes('identify')
    const read = readScopePath(expanded!)
    const path = read ?? writeScopePath(expanded!)
    return path !== undefined && (read === undefined ? writeScopePaths : readScopePaths)(this.scopes).some(granted => scopeCovers(granted, path))
  }

  /** Whether the granted scopes allow writing `path` (relative paths are in the app's own directory). */
  canWrite(path: string): boolean {
    try {
      return !!this.#checkWritable(path)
    } catch {
      return false
    }
  }

  /**
   * Whether the session may read `path`: every public file, and private files that a `write:` or `read:` scope covers
   * (relative paths are in the app's own directory).
   */
  canRead(path: string): boolean {
    try {
      const absolute = this.resolve(path)
      validatePath(absolute, this.server.wellKnownPaths)
      return scopesAllowReading(this.scopes, absolute)
    } catch {
      return false
    }
  }

  /**
   * Whether `path` is private (RFC-6 "Private areas"): in the app's private folder `private/`, or in `/pups/private/`.
   * Private files can be read only with this session's token, and have no public URL.
   */
  isPrivate(path: string): boolean {
    return isPrivate(this.resolve(path))
  }

  /** The absolute path for `path`: unchanged if it starts with `/`, otherwise inside the app's own directory. */
  resolve(path: string): string {
    return resolvePath(path, this.appDataPath)
  }

  /**
   * The public URL of `path`, as readers see it. Use it whenever you link to a file, e.g. as a webmention source.
   * @throws {PupsError} `invalid_path` for a private file, which has no public URL.
   */
  publicUrl(path: string): string {
    return publicUrl(this.server, this.resolve(path))
  }

  /** The URL of `path` below `storage_base`, where it is written and where its ETag is valid. */
  storageUrl(path: string): string {
    return storageUrl(this.server, this.resolve(path))
  }

  /**
   * Reads a file from `storage_base`. By default this is a fresh read (RFC-6 "Fresh reads"): it carries the access
   * token, so that no cache between the app and the server can answer with an old version, and it returns the
   * latest write. For public files the token grants nothing else. Use the ETag of the result for `replace()`; ETags
   * from `public_base` may come from a CDN.
   *
   * Private files (RFC-6 "Private areas"), in the app's private folder `private/` or in `/pups/private/`, are read
   * the same way, and need a `write:` or `read:` scope that covers them.
   *
   * With `fresh: false` the request carries no token. It may then be answered from a cache, but works without a
   * valid session. Private files can't be read this way.
   * @returns undefined if the file doesn't exist.
   * @throws {PupsError} `session_expired` for a fresh read if the session can't be renewed; `insufficient_scope` for a
   *   private file outside the granted scopes; `invalid_request` for a private file with `fresh: false`.
   */
  async get(path: string, options: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<StoredFile | undefined> {
    const absolute = this.resolve(path)
    validatePath(absolute, this.server.wellKnownPaths)
    const fresh = options.fresh ?? true
    if (isPrivate(absolute)) {
      if (!fresh)
        throw new PupsError('invalid_request', `${absolute} is private: it can only be read with the session's token, so fresh: false is not possible (RFC-6, Private areas).`)
      if (!scopesAllowReading(this.scopes, absolute)) {
        const granted = readScopePaths(this.scopes)
        throw new PupsError('insufficient_scope', `${absolute} is private and outside the granted scopes (${granted.length ? granted.join(', ') : 'none that allow reading private files'}).`)
      }
    }
    const url = storageUrl(this.server, absolute)
    const response = fresh
      ? await this._authorized(url, {}, options.signal, readTimeoutMs)
      : await fetchWithTimeout(this.#ctx.fetch, url, { credentials: 'omit', cache: 'no-store' }, readTimeoutMs, options.signal)
    if (response.status == 404) return
    if (!response.ok) throw await errorFromResponse(response, `GET ${absolute}`)
    const blob = await response.blob()
    const lastModified = response.headers.get('Last-Modified')
    return {
      path: absolute,
      etag: response.headers.get('ETag') ?? '',
      contentType: response.headers.get('Content-Type') ?? blob.type,
      size: blob.size,
      ...lastModified ? { lastModified: new Date(lastModified) } : {},
      blob: async () => blob,
      text: () => blob.text(),
      json: async () => JSON.parse(await blob.text()),
    }
  }

  /**
   * Writes a file unconditionally: the last write wins, and changes others made in between are lost.
   * Prefer `update()` for files the owner or other apps may change, and `create()` for new files.
   */
  put(path: string, body: Body, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#put(path, body, options, {})
  }

  /**
   * Creates a file that must not exist yet (`If-None-Match: *`).
   * @throws {PupsError} `precondition_failed` if the file exists.
   */
  create(path: string, body: Body, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#put(path, body, options, { 'If-None-Match': '*' })
  }

  /**
   * Replaces a file only if it is unchanged since `etag` was read (`If-Match`).
   * @throws {PupsError} `precondition_failed` if the file changed or was deleted.
   */
  replace(path: string, body: Body, etag: string, options: WriteOptions = {}): Promise<WriteResult> {
    return this.#put(path, body, options, { 'If-Match': quoteEtag(etag) })
  }

  /**
   * Changes a file safely when others may change it too (RFC-6 "Concurrency"): reads it, passes it to `change`,
   * and writes the result with `If-Match` (or `If-None-Match: *` if there was no file). If someone else wrote in
   * between, it starts again, up to `maxAttempts` times (default 5).
   *
   * `change` gets the current file, or undefined if there is none, and returns the new body, or `undefined` to
   * leave the file as it is. It may run more than once, so it must not have side effects.
   * @returns undefined if `change` returned undefined.
   */
  async update(
    path: string,
    change: (current: StoredFile | undefined) => Body | undefined | Promise<Body | undefined>,
    options: WriteOptions & { maxAttempts?: number } = {},
  ): Promise<WriteResult | undefined> {
    this.#checkWritable(path)
    const maxAttempts = options.maxAttempts ?? 5
    for (let attempt = 1; ; attempt++) {
      const current = await this.get(path, options)
      if (current && !current.etag)
        throw new PupsError('server_error', `The server sends no ETag for ${current.path}, so it can't be changed safely. It must expose the ETag header to browsers (RFC-6, CORS).`)
      const body = await change(current)
      // `null` is a valid JSON body; only undefined means "no change".
      if (body === undefined) return
      try {
        return current ? await this.replace(path, body, current.etag, options) : await this.create(path, body, options)
      } catch (e) {
        if (!isPupsError(e, 'precondition_failed') || attempt >= maxAttempts) throw e
      }
    }
  }

  /**
   * Deletes a file, if `ifMatch` is given only if it is unchanged since that ETag.
   * @throws {PupsError} `not_found` if the file doesn't exist; `precondition_failed` if it changed.
   */
  async delete(path: string, options: { ifMatch?: string; signal?: AbortSignal } = {}): Promise<void> {
    const absolute = this.#checkWritable(path)
    await this.#write('DELETE', absolute, options.ifMatch ? { 'If-Match': quoteEtag(options.ifMatch) } : {}, undefined, options.signal)
  }

  /**
   * A feed on the owner's domain, maintained according to RFC-7: the main feed `/feed.json` without a name, or the
   * named feed `/feed/<name>.json`. The session needs the feed's scopes, see `feedScopes()`.
   * @throws {PupsError} `invalid_request` for an invalid name.
   */
  feed(name?: string, options: FeedOptions = {}): PupsFeed {
    return new PupsFeed(this, name, options)
  }

  /** The feeds registered in the owner's `host-meta.json`, e.g. to let the owner choose one to post to. */
  listFeeds(options: { signal?: AbortSignal } & FeedOptions = {}): Promise<FeedLink[]> {
    return listFeeds(this, options)
  }

  /**
   * Fetches the configuration document again, e.g. after the owner changed allowed paths. Accepted only if the
   * issuer is unchanged; a different issuer means the user has to connect again.
   * @throws {PupsError} `issuer_mismatch`
   */
  async refreshServer(options: { signal?: AbortSignal } = {}): Promise<PupsServer> {
    const server = await discover(this.server.domain, this.#ctx.fetch, options.signal)
    if (server.issuer != this.server.issuer)
      throw new PupsError('issuer_mismatch', `The domain now points to another server (${server.issuer}). Log in again to connect to it.`)
    await this._tokens.updateServer(server)
    return server
  }

  /**
   * Disconnects: deletes the credentials in this browser first, so a failing network never leaves the user
   * logged in, then (with `revoke`, the default) revokes the tokens at the server, ending the grant.
   *
   * `revoke: false` only forgets the credentials here; the owner still sees the app as connected.
   * Logout doesn't delete files the app wrote, and doesn't end the app's own login session.
   * @returns whether the server confirmed the revocation. Revocation is best-effort and never throws.
   */
  async logout(options: { revoke?: boolean } = {}): Promise<{ revoked: boolean }> {
    const record = await this._tokens.takeForLogout()
    if (!record) return { revoked: false }
    this.#ctx.ended(this, { type: 'logout', me: this.me })
    if (options.revoke === false) return { revoked: false }
    const revoke = (token: string, hint: 'access_token' | 'refresh_token') =>
      revokeToken(this.#ctx.fetch, record.server, record.clientId, token, hint)
    // Revoking the refresh token ends the grant (RFC 7009); the access token is revoked as well.
    const refreshRevoked = record.refreshToken ? await revoke(record.refreshToken, 'refresh_token') : undefined
    const accessRevoked = await revoke(record.accessToken, 'access_token')
    return { revoked: refreshRevoked ?? accessRevoked }
  }

  /**
   * Sends an authenticated request. Renews the token and repeats the request once if the server answers `401`.
   * The token is sent only to the server's write endpoints.
   * @internal
   */
  async _authorized(url: string, init: RequestInit & { headers?: Record<string, string> }, signal?: AbortSignal, timeoutMs = writeTimeoutMs): Promise<Response> {
    const server = this.server
    const allowed = [server.storageBase, server.postEndpoint, server.hostMetaEndpoint].filter((u): u is string => !!u)
    if (!allowed.some(prefix => url.startsWith(prefix)))
      throw new Error(`pups-client: refusing to send a token to ${url}, which is not an endpoint of ${server.issuer}.`)
    let token = await this._tokens.accessToken()
    for (let attempt = 0; ; attempt++) {
      const response = await fetchWithTimeout(this.#ctx.fetch, url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        credentials: 'omit',
        cache: 'no-store',
      }, timeoutMs, signal)
      if (response.status != 401 || attempt) return response
      token = await this._tokens.accessToken(token)
    }
  }

  /**
   * Resolves `path` and checks it against the path rules and the granted scopes.
   * @throws {PupsError} `invalid_path`, `insufficient_scope`
   */
  #checkWritable(path: string): string {
    const absolute = this.resolve(path)
    validatePath(absolute, this.server.wellKnownPaths)
    if (!scopesCoverPath(this.scopes, absolute)) {
      const granted = writeScopePaths(this.scopes)
      throw new PupsError('insufficient_scope', `${absolute} is outside the granted scopes (${granted.length ? granted.join(', ') : 'none that allow writing'}).`)
    }
    return absolute
  }

  async #put(path: string, body: Body, options: WriteOptions, conditions: Record<string, string>): Promise<WriteResult> {
    const absolute = this.#checkWritable(path)
    const contentType = uploadContentType(absolute, options.contentType)
    const data = encodeBody(absolute, body)
    const size = data instanceof Uint8Array ? data.byteLength : data.size
    if (size > this.server.maxUploadBytes)
      throw new PupsError('too_large', `${absolute} has ${size} bytes; the server accepts at most ${this.server.maxUploadBytes}.`)
    const response = await this.#write('PUT', absolute, { 'Content-Type': contentType, ...conditions }, data, options.signal)
    return {
      path: absolute,
      etag: response.headers.get('ETag') ?? '',
      ...isPrivate(absolute) ? {} : { url: publicUrl(this.server, absolute) },
      created: response.status == 201,
    }
  }

  /** Sends a write to `storage_base`, or through the POST fallback if the server declares `post_endpoint`. */
  async #write(method: 'PUT' | 'DELETE', path: string, headers: Record<string, string>, body: Blob | Uint8Array<ArrayBuffer> | undefined, signal?: AbortSignal) {
    const { postEndpoint } = this.server
    const url = postEndpoint
      ? `${postEndpoint}${postEndpoint.includes('?') ? '&' : '?'}method=${method}&path=${encodeURIComponent(path)}`
      : storageUrl(this.server, path)
    const response = await this._authorized(url, { method: postEndpoint ? 'POST' : method, headers, body }, signal)
    if (!response.ok) throw await errorFromResponse(response, `${method} ${path}`)
    return response
  }
}

/** ETags are sent as received (`"…"` or `W/"…"`); a bare value gets quotes. */
const quoteEtag = (etag: string) => /^(W\/)?"/.test(etag) ? etag : `"${etag}"`

function encodeBody(path: string, body: Body): Blob | Uint8Array<ArrayBuffer> {
  if (typeof body == 'string') return new TextEncoder().encode(body)
  if (typeof Blob != 'undefined' && body instanceof Blob) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0))
  if (ArrayBuffer.isView(body)) {
    // A copy, so the body can be replayed even if the caller reuses the buffer.
    const copy = new Uint8Array(body.byteLength)
    copy.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    return copy
  }
  if (typeof ReadableStream != 'undefined' && body instanceof ReadableStream)
    throw new PupsError('invalid_request', 'Streams are not accepted as a body, because a request must be repeatable. Pass a Blob instead.')
  const plain = body === null || typeof body != 'object' || Array.isArray(body) || [Object.prototype, null].includes(Object.getPrototypeOf(body))
  if (!plain)
    throw new PupsError('invalid_request', `Can't send a ${body.constructor?.name ?? 'object'} as a body. Pass a string, Blob, ArrayBuffer, typed array, or a plain JSON value.`)
  if (fileTypeOf(path).extension != 'json')
    throw new PupsError('invalid_request', `${path}: JSON values can only be written to .json files. Pass a string for other text formats.`)
  return new TextEncoder().encode(JSON.stringify(body))
}
