# pups-client: Concept for a Browser Client Library

Nov 13, 2026 · Draft · Implements [RFC-6: Personal Upload Server](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md), `spec_version` 0.1

## Summary

`pups-client` is a TypeScript library that lets a browser app connect to a user's Personal Upload Server (PUPS), sign the user in with their domain, and write files to that domain. It is the reference client for RFC-6 and is published under the MIT license.

An app needs four calls:

```ts
const pups = new PupsClient({ clientId: 'https://app.example/oauth/client.json', redirectUri: 'https://app.example/callback' })
const session = await pups.init() ?? await pups.login('tim.example.com', { scopes: ['appdata'] })
await session.put('hello.json', { hello: 'world' })
await session.logout()
```

The library hides everything RFC-6 requires of a client: discovery through `host-meta.json`, OAuth 2.1 with PKCE, the `iss` and `me` checks, token refresh with rotation, safe storage of the credentials, coordination between browser tabs, file-type and path rules, ETag concurrency, the POST fallback and the `host-meta.json` endpoint.

## Goals and non-goals

**Goals**

- **Easy to use correctly.** The obvious call is the safe one. Security checks the RFC puts on clients (`state`, `iss`, `me`, PKCE, exact redirect URI, no tokens in URLs) happen inside the library and can't be switched off.
- **Complete for RFC-6 clients**: authorization, uploads, deletes, `host-meta.json` edits, sign-in with the domain, logout with revocation.
- **Safe credential storage** within what a browser allows, with an honest description of what that is (see [Credential storage](#credential-storage)).
- **Works with several tabs.** Refresh-token rotation with reuse detection means two tabs refreshing at the same time would revoke the grant. The library prevents that.
- **Reference quality**: readable code that follows the RFC section by section, TSDoc on every export, tests for every client-side rule.
- **Small**: no runtime dependencies, ESM only, tree-shakable, target below 8 KB min+gzip.

**Non-goals**

- **Server-side apps.** The core is written against `fetch` and Web Crypto and runs in Node too (the CLI uses it), but a helper for backends that redeem codes is outside version 1.
- **Framework bindings** (React hooks, Vue composables). They are thin wrappers that apps or separate packages can provide.
- **Feed or profile formats.** The library writes bytes. Building RSS, JSON Feed, OPML or vCard files is the app's job.
- **The app's own login session.** The library tells the app who the user is (`me`). Cookies, accounts and sessions on the app's backend are the app's business.
- **Hosting the client metadata document.** The app publishes its `client.json`. The library offers a checker for it during development.

## Quick start

### 1. Publish the client metadata document

The app publishes a [CIMD](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) document on its own domain. Its URL is the `client_id`:

```json
{
  "client_id": "https://app.example/oauth/client.json",
  "client_name": "Example Reader",
  "client_uri": "https://app.example/",
  "logo_uri": "https://app.example/logo.png",
  "redirect_uris": ["https://app.example/callback"]
}
```

The PUPS server fetches it during authorization, so it must be served over HTTPS from a public host. `client_uri` and `logo_uri` must be on the same host as `client_id` (a `www.` difference is allowed). The consent screen shows the owner the host of `client_id` in large type, so that host should be the one users know.

### 2. Create the client once

```ts
import { PupsClient } from 'pups-client'

export const pups = new PupsClient({
  clientId: 'https://app.example/oauth/client.json',
  redirectUri: 'https://app.example/callback',
})
```

### 3. On every page load, pick up a session

```ts
let session = await pups.init()   // handles a pending redirect, else restores a stored session
```

### 4. Connect

```ts
loginButton.onclick = async () => {
  session = await pups.login(domainInput.value, { scopes: ['identify', 'appdata'] })
  // A full-page redirect: this promise never resolves. The session arrives via init() after the redirect.
}
```

Or without leaving the page:

```ts
loginButton.onclick = async () =>
  session = await pups.loginWithPopup(domainInput.value, { scopes: ['appdata'] })
```

### 5. Write files

```ts
console.log(`Signed in as ${session.me}`)                 // 'https://tim.example.com/'
const { url } = await session.put('notes/today.md', '# Hello', { contentType: 'text/markdown' })
await session.update('comments.json', feed => addItem(feed, comment))
await session.delete('notes/today.md')
```

### 6. Disconnect

```ts
await session.logout()   // forgets the credentials locally and revokes the grant at the server
```

## Architecture

```
┌──────────────────────────── PupsClient ────────────────────────────┐
│ discover()  login()  loginWithPopup()  handleRedirect()  init()     │
│ restore()  sessions()  onSessionChange()  checkClientMetadata()     │
└───────┬───────────────┬──────────────────┬─────────────────────────┘
        │               │                  │
  discovery.ts      oauth.ts           session.ts ── PupsSession
  host-meta.json    PKCE, authorize    put/create/replace/update/delete/get
  config document   code exchange      hostMeta.*  logout()
  validation        refresh, revoke          │
        │               │                    │
        └───────┬───────┴─────────┬──────────┘
                │                 │
          tokens.ts          paths.ts / file-types.ts
          access token cache  path rules, extension table,
          cross-tab refresh   POST fallback, error mapping
          (Web Locks,
          BroadcastChannel)
                │
          store/  TokenStore interface
          IndexedDbTokenStore (default, encrypted)
          MemoryTokenStore
```

| Module | Responsibility | RFC-6 section |
| --- | --- | --- |
| `discovery.ts` | Normalize the domain, fetch `host-meta.json` and the configuration document, validate them | Discovery |
| `oauth.ts` | PKCE, authorization URL, callback parsing, code exchange, refresh, revocation, `iss` and `me` checks | Authorization, Tokens, Sign-in with your domain |
| `scopes.ts` | Scope shorthands, validation against the configuration, `canWrite()` | Scopes |
| `paths.ts` | Path resolution and the client-side mirror of the path rules, public URLs | Paths, Public URLs |
| `file-types.ts` | Extension allowlist, `Content-Type` inference and validation | File types |
| `session.ts` | Requests to `storage_base` or `post_endpoint`, ETags, error mapping | Upload API, POST fallback |
| `host-meta.ts` | Requests to `host_meta_endpoint` | Editing host-meta.json |
| `tokens.ts` | In-memory access token, refresh with cross-tab lock, broadcast of changes | Refresh |
| `store/` | Persistence of sessions, encryption at rest | — |
| `errors.ts` | `PupsError` and its codes | Errors |

Everything is `async` and returns promises. No call blocks, and no call uses callbacks except event subscriptions.

## API

The signatures below are the contract. Names follow the RFC where possible (`me`, `issuer`, `scope`), in camelCase.

### `PupsClient`

```ts
class PupsClient {
  constructor(options: PupsClientOptions)

  /** Finds the PUPS server of a domain. Useful to check what a server offers before asking for scopes. */
  discover(domain: string, options?: { signal?: AbortSignal }): Promise<PupsServer>

  /** Starts authorization with a full-page redirect. The promise never resolves. */
  login(domain: string | PupsServer, options?: LoginOptions): Promise<never>

  /** Starts authorization in a popup and resolves with the session. Call it directly in a click handler. */
  loginWithPopup(domain: string | PupsServer, options?: LoginOptions & { timeoutMs?: number; signal?: AbortSignal }): Promise<PupsSession>

  /**
   * Completes authorization on the redirect URI page. Returns undefined if the URL is not an authorization response.
   * In the popup it relays the response to the opening tab and closes the window.
   */
  handleRedirect(options?: { url?: string; redeem?: boolean }): Promise<RedirectResult | undefined>

  /** handleRedirect() if the URL is an authorization response, otherwise restore(). The usual call on page load. */
  init(): Promise<PupsSession | undefined>

  /** For native apps and custom flows: creates the authorization URL without navigating. */
  createAuthorization(domain: string | PupsServer, options?: LoginOptions & { signal?: AbortSignal }): Promise<PendingAuthorization>

  /** Finishes a flow started with createAuthorization(), given the URL the server redirected to. */
  completeAuthorization(callbackUrl: string, pending: PendingAuthorization, options?: { redeem?: boolean }): Promise<RedirectResult>

  /** Returns the stored session for `me`, or the most recently used one. */
  restore(me?: string): Promise<PupsSession | undefined>

  /** All stored sessions of this client, one per connected domain. */
  sessions(): Promise<PupsSession[]>

  /** Called on login, logout, expiry and revocation, also when they happen in another tab. Returns an unsubscribe function. */
  onSessionChange(listener: (event: SessionChangeEvent) => void): () => void

  /** Development helper: fetches the app's client metadata document and reports everything a PUPS server would reject. */
  checkClientMetadata(): Promise<ClientMetadataReport>
}

interface PupsClientOptions {
  clientId: string                 // https URL of the client metadata document
  redirectUri: string              // must be listed in the client metadata document, exactly
  store?: TokenStore               // default: new IndexedDbTokenStore()
  fetch?: typeof fetch             // for tests and instrumentation
}

interface LoginOptions {
  scopes?: Scope[]                 // default: ['appdata']
  appState?: unknown               // JSON-serializable, returned by handleRedirect(), e.g. the page to return to
  persist?: boolean                // default true; false keeps the session in memory only
}

interface RedirectResult {
  session?: PupsSession            // absent with redeem: false, and in the popup
  appState?: unknown
  code?: AuthorizationCode         // only with redeem: false, see "Sign-in through the app's backend"
}

type SessionChangeEvent =
  | { type: 'login'; me: string }
  | { type: 'logout'; me: string }
  | { type: 'expired'; me: string; error: PupsError }   // refresh failed: grant revoked or refresh token expired
```

`PupsServer` is the validated configuration document plus the discovery result:

```ts
interface PupsServer {
  domain: string                   // normalized: 'https://tim.example.com/'
  identityHosts: string[]          // hosts `me` may name: the entered one, plus the final host if discovery was redirected
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string
  storageBase: string
  publicBase: string
  wellKnownPaths: WellKnownPath[]  // { path, url?, rels, properties }
  hostMetaEndpoint?: string
  postEndpoint?: string
  maxUploadBytes: number
  specVersion: string
  raw: Record<string, unknown>     // the configuration document as fetched, including unknown fields
}
```

### Scopes

```ts
type Scope = 'identify' | 'appdata' | `write:/${string}`
```

- `'identify'` is passed through. With it alone, the session can't write, and the server may issue no refresh token.
- `'appdata'` is a shorthand for `write:/appdata/<client-host>/`, computed from `clientId`. Apps should not spell out their own directory.
- `write:/…` must be a well-known path declared in the server's `wellKnownPaths`, or a directory or file under a declared directory.

`login()` checks every scope against the server before redirecting and throws `invalid_scope` for anything the server would reject. That turns a confusing OAuth error after a round trip into an immediate, explained error. Apps that want to offer a feature only if the server supports it check first:

```ts
const server = await pups.discover(domain)
const canEditProfile = server.wellKnownPaths.some(p => p.path == '/.well-known/about.md')
```

**The owner may drop scopes.** `session.scopes` holds the granted scopes, which may be fewer than requested. Apps check with `session.canWrite(path)` or `session.hasScope(scope)` and degrade gracefully. Dropping every scope is a denial and throws `access_denied`.

### `PupsSession`

```ts
interface PupsSession {
  readonly me: string              // verified identity, 'https://tim.example.com/'
  readonly issuer: string
  readonly scopes: readonly string[]  // granted, not requested
  readonly server: PupsServer
  readonly appDataPath: string     // '/appdata/app.example/'
  readonly persistent: boolean

  hasScope(scope: Scope): boolean
  canWrite(path: string): boolean
  resolve(path: string): string    // 'a/b.json' → '/appdata/app.example/a/b.json'; '/x' stays '/x'
  publicUrl(path: string): string  // the URL readers use, e.g. for an RFC-4 webmention source
  storageUrl(path: string): string

  get(path: string, options?: { signal?: AbortSignal; fresh?: boolean }): Promise<StoredFile | undefined>
  put(path: string, body: Body, options?: WriteOptions): Promise<WriteResult>
  create(path: string, body: Body, options?: WriteOptions): Promise<WriteResult>
  replace(path: string, body: Body, etag: string, options?: WriteOptions): Promise<WriteResult>
  update(path: string, change: (current: StoredFile | undefined) => Body | undefined | Promise<Body | undefined>,
         options?: WriteOptions & { maxAttempts?: number }): Promise<WriteResult | undefined>
  delete(path: string, options?: { ifMatch?: string; signal?: AbortSignal }): Promise<void>

  readonly hostMeta: HostMetaEditor

  logout(options?: { revoke?: boolean }): Promise<{ revoked: boolean }>
}

type Body = string | Blob | ArrayBuffer | ArrayBufferView | JsonValue

interface WriteOptions {
  contentType?: string             // default: the served type of the extension
  signal?: AbortSignal
}

interface WriteResult {
  path: string                     // normalized absolute path
  etag: string
  url: string                      // public URL
  created: boolean                 // 201 vs 200
}

interface StoredFile {
  path: string
  etag: string
  contentType: string
  lastModified?: Date
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  blob(): Promise<Blob>
}
```

**Paths.** A path that starts with `/` is absolute, relative to `storage_base`. A path without a leading `/` is relative to the app's own directory. `session.put('comments.json', …)` writes `/appdata/app.example/comments.json`. This makes the common case short and the uncommon case (well-known paths) explicit.

**Writes.** Four methods map to the four ways RFC-6 writes a file:

| Method | Request | Fails with `precondition_failed` when |
| --- | --- | --- |
| `create(path, body)` | `PUT` + `If-None-Match: *` | the file exists |
| `replace(path, body, etag)` | `PUT` + `If-Match: "<etag>"` | the file changed since `etag` |
| `update(path, change)` | `GET`, then `create` or `replace`, repeated on `412` (default 5 attempts) | it still conflicts after the last attempt |
| `put(path, body)` | unconditional `PUT` | never; last write wins |

`update()` is the recommended way to change files that the owner or other apps may also edit, such as feeds and well-known files. Its callback gets the current file (or `undefined` if there is none) and returns the new body, or `undefined` to leave the file unchanged. It may run more than once, so it must not have side effects.

`put()` exists because the RFC allows unconditional writes and because media uploads with unique names don't need a condition. Its TSDoc says that it overwrites changes of others.

**Bodies.** Strings are sent as UTF-8. Plain objects and arrays are serialized with `JSON.stringify`, allowed only for `.json` paths. `Blob`, `ArrayBuffer` and typed arrays are sent as they are. `ReadableStream` is not accepted: a body must be replayable, because the library retries once after refreshing an expired token. Uploads larger than `server.maxUploadBytes` fail with `too_large` before any request.

**Content types.** The extension decides the type, as in the RFC. Without `contentType`, the library sends the served type from the extension table (`.json` → `application/json`). With `contentType`, it must be one of the accepted types for the extension (e.g. `application/feed+json` for `.json`), or the call fails with `unsupported_type` before any request. A blocked extension anywhere in the name (`feed.php.json`) fails the same way.

**Reads.** `get()` reads from `storage_base`, because only ETags from `storage_base` are valid for conditions. By default it is a **fresh read** (RFC-6 "Fresh reads"): it carries the access token, so that no CDN or caching proxy between the app and the server can answer with an old version, and the server returns the latest write with `Cache-Control: private, no-store`. Without it, a cache that kept an old version would make the user miss their own changes, and `update()` would fail with `412` on every attempt, because it would read the same old ETag each time. The token grants nothing else, since every stored file is public; any valid token works, `identify` included. `get(path, { fresh: false })` sends no token: it may be answered from a cache, but works without a valid session. `get()` returns `undefined` on `404`.

### `HostMetaEditor`

```ts
interface HostMetaEditor {
  readonly available: boolean      // false if the server has no host_meta_endpoint
  get(): Promise<HostMetaDocument> // the public /.well-known/host-meta.json, for display
  allowsRel(rel: string, href: string): boolean  // whether the granted scopes allow this rel for this file
  allowedProperties(): string[]              // properties the granted scopes allow
  addLink(link: { rel: string; href: string; type?: string }): Promise<void>
  removeLink(link: { rel: string; href: string }): Promise<void>
  setProperty(property: string, value: string): Promise<void>
}
```

- `href` may be a path (`index.json` in the app's own directory, `/feed/photos.json`) or a full public URL. Paths are turned into public URLs with `publicUrl()`. Either way, the library checks that the file lies inside a granted scope.
- `allowsRel()` and `allowedProperties()` follow the RFC: for a file under a well-known path, the `rels` and `properties` declared for that path in `wellKnownPaths`, if its scope is granted; for a file in the app's own directory, URI rels on the client host (with or without `www.`). Calls outside them fail with `insufficient_scope` before any request.
- Some rules are known only to the server: which rels are **single-valued** and which properties take a **URL** as their value come from the bigwide.net list of well-known paths and are not in the configuration document. The library therefore can't check them in advance. A taken single-valued rel ends with `conflict`; a URL value outside the granted scope ends with `insufficient_scope` or `invalid_request`, as the server answers.
- `setProperty` checks what it can: a non-empty string of at most 2,048 characters without control characters.
- If `available` is false, every write method throws `unsupported`.

### `PupsFeed`

`session.feed(name?, options?)` returns a `PupsFeed` for the main feed `/feed.json` or the named feed `/feed/<name>.json`, maintained according to [RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md). `feedScopes(name?)` lists the two scopes it needs: the feed file and the feed directory.

```ts
interface PupsFeed {
  readonly name?: string           // undefined for the main feed
  readonly path: string            // '/feed.json', '/feed/photos.json'
  readonly directory: string       // '/feed/', '/feed/photos/'
  readonly url: string             // feed_url
  readonly writable: boolean

  load(): Promise<FeedState>       // missing | pups (with feed and etag) | foreign | invalid
  create(setup: FeedSetup, options?: { register?: boolean }): Promise<{ url: string; registered: boolean }>
  register(): Promise<boolean>     // host-meta.json link with https://bigwide.net/ns/feed
  updateSettings(changes: FeedSettingsChanges): Promise<FeedDocument>
  setIcon(media: MediaInput | null): Promise<FeedDocument>
  setFavicon(media: MediaInput | null): Promise<FeedDocument>
  uploadMedia(media: MediaInput, options?: { folder?: string }): Promise<MediaResult>

  addPost(post: PostInput): Promise<PostResult>   // url: the post's archive URL + '#id'
  getPost(id: string): Promise<PostResult | undefined>
  posts(): AsyncGenerator<FeedItem>
  editPost(id: string, changes: PostChanges | ((item: FeedItem) => FeedItem | undefined)): Promise<PostResult>
  deletePost(id: string, options?: { deleteMedia?: boolean }): Promise<{ item: FeedItem; deletedMedia: string[] }>
}
```

- **The marker.** Every feed file and archive the library creates carries `"_pups": { "pupsControlled": true }`. Files without it are never written; writes fail with `not_pups_controlled`. On every write of the feed file, the library sets the fixed fields (`version`, `home_page_url`, `feed_url`, `user_comment`), so a feed the owner handed over gets them on its first write.
- **Settings.** `create()` and `updateSettings()` accept only the owner's fields (`title`, `description`, `authors`, `language`, `expired`) and extensions starting with `_` (except `_pups`). Icons go through `setIcon()` and `setFavicon()`, which upload a new file to `/feed/images/icons/` (`/feed/<name>/images/icons/` for a named feed) and delete the old one.
- **Layout.** Named feeds share `/feed/` with the main feed, so the main feed's media go only into `/feed/images/` and `/feed/media/`, the names `images` and `media` can't be feed names, and `deletePost(…, { deleteMedia: true })` on the main feed never touches files of named feeds.
- **Posting.** `addPost()` adds the post to the newest archive (the one `_pups.archive_url` names), or creates a new archive linked to it once the newest holds `archiveSize` (20) posts, and then inserts it at the top of the feed file, which keeps the newest `maxItems` (30), fewer with `maxBytes`. The archive is written first; the feed file always takes all posts of the newest archive, which repairs interrupted posts. Every step is repeated on `412`, up to `maxAttempts` (8). A feed without `archive_url` (new, written by simple clients, or handed over) gets its existing items archived first, oldest first, with its old `next_url` at the end of the chain, unless `startArchives` is false: then posts only go into the feed file, as RFC-7 allows for clients without archive support.
- **Post URLs.** `PostResult.url` is the post's archive URL plus `#<id>`. Posts never leave their archive, so it never changes; an RFC-4 webmention uses it as `source`.
- **Editing and deleting** find the post in the archives, from `_pups.archive_url` along `next_url`, change its archive, and then the feed file if the post is there. After a delete, the feed file is filled up again from the archives. `deletePost(id, { deleteMedia: true })` reads all archives to find media no other post references.
- **Ids** are 16 random URL-safe characters unless given; `date_published` defaults to now; `markdown` goes into `_source.markdown` (RFC-1), with `content_text` as the fallback JSON Feed requires.

### Errors

Every failure is a `PupsError`:

```ts
class PupsError extends Error {
  readonly code: PupsErrorCode
  readonly status?: number         // HTTP status, when a response caused it
  readonly serverMessage?: string  // `message` from the server's JSON error body
  readonly retryable: boolean      // network errors, 429, 5xx except 507
  readonly cause?: unknown
}

type PupsErrorCode =
  // discovery
  | 'invalid_domain' | 'no_pups_server' | 'invalid_server_config' | 'unsupported_server_version'
  // authorization
  | 'invalid_scope' | 'access_denied' | 'state_mismatch' | 'issuer_mismatch' | 'identity_mismatch'
  | 'popup_blocked' | 'popup_timeout' | 'authorization_failed'
  // session
  | 'session_expired'              // refresh failed for good: log in again
  // uploads, as in the RFC's error table
  | 'invalid_path' | 'invalid_token' | 'insufficient_scope' | 'not_found' | 'precondition_failed'
  | 'too_large' | 'unsupported_type' | 'insufficient_storage' | 'conflict' | 'rate_limited' | 'invalid_request'
  // feeds (RFC-7)
  | 'not_pups_controlled' | 'invalid_feed'
  // other
  | 'unsupported' | 'network' | 'aborted' | 'server_error'
```

Upload error codes are the RFC's `error` values, so apps can switch on them directly. Errors detected before a request (an invalid path, a wrong type, an ungranted scope) use the same codes as the server would, so apps handle both the same way. Messages are written for developers and name the rule that failed, e.g. `Path segment ".htaccess" starts with a dot (RFC-6, Paths).`

## Flows in detail

### Discovery

1. **Normalize** the input to `https://<host>/` with `new URL()`: add `https://` if no scheme is given; reject other schemes than `https`; lowercase the host; IDNs become punycode (the URL parser does that); drop port, path, query and fragment.
2. **Fetch** `https://<host>/.well-known/host-meta.json` with `credentials: 'omit'`, `redirect: 'follow'`, `Accept: application/json` and a 10-second timeout. Take the first link with rel `https://bigwide.net/ns/personal-storage`.
3. **Fetch** the configuration document from its `href`, which must be HTTPS.
4. **Validate**: required fields present and of the right type; every endpoint and base is HTTPS; `storage_base` and `public_base` end with `/`; `spec_version` is supported (`0.1`); unknown fields are ignored.
5. **Record identity hosts**: the entered host, and the host of the final `host-meta.json` URL if the request was redirected (the RFC's `www.` rule).

**Browser limitation.** `fetch` follows up to 20 redirects and doesn't expose the chain, so the library can't enforce the RFC's limit of 3. It does check that the final URL (`response.url`) is HTTPS and treats any other result as `no_pups_server`.

### Authorization by redirect

1. Discover (unless a `PupsServer` is passed), validate scopes, expand `'appdata'`.
2. Create a `code_verifier` of 64 characters from 48 random bytes (`crypto.getRandomValues`), `code_challenge = BASE64URL(SHA-256(verifier))` and a `state` of 32 random bytes, prefixed `r.` (see the popup flow for why).
3. Save the pending request in `sessionStorage` under `pups-client:pending:<state>`: verifier, server snapshot, requested scopes, `appState`, `persist`, creation time. `sessionStorage` is per tab and survives the redirect. Pending requests older than 10 minutes are discarded.
4. `location.assign(authorizationUrl)`.

### Authorization by popup

Popups are blocked unless they open synchronously during a user gesture, but discovery is asynchronous. `loginWithPopup()` therefore opens an empty popup (`window.open('', 'pups-login', 'popup,width=480,height=720')`) before its first `await`, and navigates it when discovery is done. If `window.open` returns `null`, it throws `popup_blocked`; apps fall back to `login()`.

The verifier stays in the opener's memory. `state` is prefixed `p.`. When the popup returns to the redirect URI, the page there calls `init()` or `handleRedirect()` like in the redirect flow; seeing the `p.` prefix, the library posts `{ state, code, iss, error }` on a `BroadcastChannel` named after the `clientId` and closes the window. The opener takes the message whose `state` matches and redeems the code.

A `BroadcastChannel` is used instead of `window.opener.postMessage`, because the PUPS consent page may send `Cross-Origin-Opener-Policy`, which cuts the link between popup and opener. For the same reason the library does not poll `popup.closed`: it can report `true` while the popup is still open. The flow ends with the response, after `timeoutMs` (default 5 minutes, `popup_timeout`), or when the `signal` aborts.

### Callback and code exchange

`handleRedirect()` on the redirect URI page:

1. Reads `code`, `state`, `iss` and `error` from the URL, and immediately removes them with `history.replaceState`, so the code doesn't stay in the history, bookmarks or the `Referer` of later requests.
2. Finds the pending request by `state`. No match → `state_mismatch`. The pending entry is deleted at once, so a response can't be used twice.
3. `error=access_denied` → `access_denied`; other errors → `authorization_failed` with the OAuth error code.
4. Checks `iss` == `server.issuer` **before** redeeming the code. Missing or different → `issuer_mismatch`. This is the RFC's mix-up defence.
5. `POST` to the token endpoint: `grant_type=authorization_code`, `code`, `client_id`, `redirect_uri`, `code_verifier`.
6. **Verifies `me`**: normalized, its host must be one of `identityHosts`. If not, the library runs discovery on `me` and accepts it only if that leads to the same issuer; otherwise `identity_mismatch`, and the tokens are revoked and discarded.
7. Stores the session (unless `persist: false`), broadcasts `login`, returns the session and `appState`.

### Token lifecycle

- The **access token** is kept in memory, together with its expiry (`expires_in` minus 60 seconds of clock skew). It is also persisted, encrypted, so that a page reload doesn't need a refresh.
- Before each authenticated request the library gets a valid access token, refreshing if needed. If the server still answers `401 invalid_token` (the owner revoked the grant, or the clock was off), the library refreshes once and repeats the request once.
- **Refresh** returns a new refresh token every time; the library stores it before it uses the new access token.
- **Refresh fails for good** (`invalid_grant`, `401`): the session is deleted from the store, `expired` is emitted to all tabs and the call throws `session_expired`. The app asks the user to connect again.
- **Refresh fails temporarily** (network, `5xx`): the library retries within the RFC's grace period (see [Lost refresh responses](#lost-refresh-responses)). If every attempt fails, the stored tokens are kept and the call throws a `retryable` error.

### Refreshing safely with several tabs

The RFC revokes the whole grant when a replaced refresh token is used again. Its grace period doesn't help with concurrency: two tabs that refresh at the same moment would send the same refresh token, the second refresh would revoke the tokens of the first, and as soon as the first tab used its new token, the grant would be gone. The library serializes refreshes across tabs:

```ts
const accessToken = async () =>
  memoryTokenValid() ? memoryToken() : navigator.locks.request(`pups-client:refresh:${clientId}:${me}`, async () => {
    const record = await store.get(clientId, me)          // another tab may have refreshed meanwhile
    if (!record) throw new PupsError('session_expired')
    if (stillValid(record)) return useRecord(record)
    const tokens = await refresh(record.refreshToken)
    await store.put({ ...record, ...tokens })
    channel.postMessage({ type: 'tokens', me })            // no tokens on the channel; other tabs reread the store
    return useRecord(tokens)
  })
```

- [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) give a lock shared by all tabs and workers of the origin, released automatically if a tab closes.
- After getting the lock, the library rereads the store; if another tab already refreshed, it uses that result.
- A `BroadcastChannel` tells other tabs about new tokens, logout and expiry, so they update their memory and fire `onSessionChange`. Tokens never travel over the channel.
- Where Web Locks are missing, the library falls back to a lock inside the tab and documents the remaining risk.

### Lost refresh responses

A refresh response can get lost: the server has rotated the refresh token, but the connection dropped before the library received the new one. RFC-6 keeps the replaced refresh token usable for a grace period of at least 60 seconds, as long as nothing from the new pair has been used. The library relies on exactly that, and nothing more:

- **Prompt retries under the lock.** If a refresh fails with a network error, a timeout or a `5xx`, the library retries with the same refresh token while it still holds the lock, after 1, 4 and 15 seconds. No attempt starts later than 45 seconds after the first one, so all of them fall inside the 60 seconds the RFC guarantees. Other tabs wait for the lock and then use the result.
- **Store before use.** The new tokens are written to the store before any of them is used. If writing fails, the library keeps the session in this tab's memory only and deletes the stored record, so that no tab sends the replaced token later, after the grace period, which would revoke the grant.
- **What remains.** If every retry fails, the library can't tell whether the server received the refresh. It keeps the stored tokens and throws a `retryable` error. A later attempt either succeeds (the server never saw the request) or, after the grace period, revokes the grant and ends with `session_expired`. Apps should treat `session_expired` as "connect again", never as an error to report.

### Uploads

For every write, before any request:

1. **Resolve** the path (relative → app directory). Apps pass plain, unencoded paths; the library encodes them. Then apply the RFC's path rules: at most 512 bytes UTF-8, no trailing `/`, no empty, `.` or `..` segments, no segment that starts with a dot (except declared `/.well-known/` files), no `\`, `:` or control characters, no segment ending in `.` or a space.
2. **Check the scope** segment by segment against the granted scopes → `insufficient_scope`.
3. **Check the type**: allowed extension, no blocked extension anywhere in the name, `contentType` accepted for the extension → `unsupported_type`.
4. **Check the size** against `maxUploadBytes` → `too_large`.

Then the request: each segment is encoded with `encodeURIComponent` and appended to `storage_base`. Headers: `Authorization: Bearer …`, `Content-Type`, and `If-Match` / `If-None-Match` as the method requires. `credentials: 'omit'`, `cache: 'no-store'`.

If the server declares `post_endpoint`, every write goes there instead, as `POST <post_endpoint>?method=PUT&path=<encoded path>` with the same headers and a raw body. Apps don't see the difference.

**Dot segments.** `fetch` resolves `.` and `..` segments in a URL, also as `%2e`, before the request leaves the browser (WHATWG URL standard), and so may CDNs on the way. RFC-6 therefore applies the scope check to the resolved path. The library never relies on that: it rejects dot segments before building the URL, so the URL it sends always names exactly the path the app passed. In the `path` parameter of the POST fallback, which nothing resolves, the same check applies.

The client-side checks mirror the server's rules for fast, clear errors. They never replace them: the server stays authoritative, and any server error is mapped to the same `PupsError` codes.

The access token is only ever sent to URLs that start with the server's `storage_base`, `post_endpoint`, `host_meta_endpoint`, `token_endpoint` or `revocation_endpoint`. An internal assertion enforces that, and there is no public way to read the access token.

### Editing `host-meta.json`

`addLink`, `removeLink` and `setProperty` send `POST <host_meta_endpoint>` with the JSON body defined by the RFC (`action: 'add' | 'remove' | 'set-property'`). Status codes map to `PupsError`: `400` → `invalid_request`, `403` → `insufficient_scope`, `409` → `conflict`, `413` → `too_large`. The server does the read-modify-write on the file; the client doesn't retry `409`, because it means a single-valued rel is taken or the file is invalid, which the user has to resolve.

### Logout

`session.logout()`:

1. Reads the tokens, then **deletes the session from the store first** and broadcasts `logout`, so a failing network can never leave the user logged in.
2. With `revoke: true` (the default), sends `POST <revocation_endpoint>` for the refresh token (`token_type_hint=refresh_token`, `client_id`), then for the access token. Revoking the refresh token ends the grant on servers that follow RFC 7009.
3. Returns `{ revoked }`. Revocation is best-effort: a failure is reported, not thrown, because the local session is already gone.

`revoke: false` only forgets the credentials in this browser; the grant stays, and the owner sees the app as connected. That is useful for "switch account" but not for "disconnect".

Logout neither deletes the files the app wrote nor logs the user out of the app's own backend. The TSDoc says so.

## Credential storage

### What is stored

Per connected domain, one record, keyed by `clientId` and `me`:

```ts
interface SessionRecord {
  clientId: string
  me: string
  server: PupsServer              // pinned at login; restore() does not rediscover
  scopes: string[]
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken?: string
  createdAt: number
  lastUsedAt: number
}
```

The server configuration is pinned at login, so a later change to `host-meta.json` can't silently redirect tokens to another issuer. `session.refreshServer()` rediscovers on demand and accepts the result only if the issuer is unchanged; a different issuer means the user has to connect again.

During an authorization, the pending request (verifier, state, server snapshot) lives in `sessionStorage` for at most 10 minutes. It holds no token.

### `IndexedDbTokenStore` (default)

- Records are stored in an IndexedDB database `pups-client`, encrypted with **AES-GCM** (256-bit key, random 96-bit IV per write).
- The key is generated with `crypto.subtle.generateKey(…, extractable: false, …)` and stored as a `CryptoKey` object in the same database. IndexedDB can store non-extractable keys; their raw bytes are never available to JavaScript.
- IndexedDB, unlike `localStorage`, is asynchronous, can hold `CryptoKey` objects, and is not exposed as plain strings to every script that enumerates `localStorage`.

### What this protects, and what it does not

Browser storage cannot be made safe against code running on the app's own origin. The design is honest about that:

| Threat | Protected? |
| --- | --- |
| Someone reads the browser profile on disk, a backup or a synced profile | **Yes**: they get ciphertext; the key can't be exported from the browser |
| Tokens show up in logs, error reports or devtools screenshots of storage | **Yes**: they are never logged, and stored only encrypted |
| Tokens in URLs, `Referer` headers or history | **Yes**: never in URLs; the code is removed from the URL at once |
| Another origin, including the PUPS server's other apps | **Yes**: storage is per origin |
| A copied token used later | **Partly**: access tokens live 1 hour; refresh tokens rotate, and reuse revokes the grant |
| XSS on the app's origin | **No**: injected script can call the library, or decrypt with the stored key, like the app itself |

The real defences against XSS belong to the app, and the documentation spells them out: a strict Content Security Policy (`script-src 'self'`, no inline script), Trusted Types, no third-party scripts on pages that use the library, dependency hygiene. The owner can revoke the grant on the PUPS apps page at any time.

Sender-constrained tokens ([DPoP](https://www.rfc-editor.org/rfc/rfc9449)) would close most of the gap: with a non-extractable signing key, a stolen token is useless outside the browser. RFC-6 lists DPoP as an open question; the store and token modules are designed so that a DPoP key can be added to the record later.

### Other stores

```ts
interface TokenStore {
  get(clientId: string, me: string): Promise<SessionRecord | undefined>
  list(clientId: string): Promise<SessionRecord[]>
  put(record: SessionRecord): Promise<void>
  delete(clientId: string, me: string): Promise<void>
}
```

- `MemoryTokenStore`: nothing persisted; the user connects again after every reload. For high-risk apps and tests. `persist: false` on `login()` uses it for one session.
- Apps can implement their own, e.g. to keep tokens in a service worker. Custom stores must be shared between tabs, or the cross-tab refresh protection doesn't work; the TSDoc states that.

## Sign-in with the domain

Apps that only need to know who the user is ask for `identify`:

```ts
const session = await pups.login(domain, { scopes: ['identify'], persist: false })
// after the redirect, in init():
showWelcome(session.me)
```

The library has already verified `state`, `iss` and `me`, so `session.me` is the verified identity, inside this browser.

### Sign-in through the app's backend

An identity checked in the browser can't be trusted by the app's server: the RFC requires the party that relies on the identity to redeem the code itself. With `redeem: false`, `handleRedirect()` verifies `state` and `iss`, then returns the code instead of redeeming it:

```ts
const { code } = await pups.handleRedirect({ redeem: false }) ?? {}
if (code) await fetch('/api/login', { method: 'POST', body: JSON.stringify(code) })
// code: { code, codeVerifier, redirectUri, clientId, issuer, tokenEndpoint, identityHosts }
```

The backend redeems it at `tokenEndpoint` and checks `me` against `identityHosts` (or rediscovers). The verifier is sent to the app's own backend only, which is the same party as the client. A server-side helper for this is planned as `pups-client/server` and is outside version 1.

## Examples

### RFC-4 comment

```ts
const session = await pups.init() ?? await pups.login(domain, { scopes: ['appdata'] })
const feedPath = 'comments.json'
const { url } = await session.update(feedPath, async file => {
  const feed = await file?.json<JsonFeed>() ?? newFeed(session.me, session.publicUrl(feedPath))
  feed.items.unshift({ id: guid, content_html: html, _in_reply_to: target })
  return feed
}, { contentType: 'application/feed+json' })
await sendWebmention({ source: `${url}#${guid}`, target })
```

The documentation for this example also covers the RFC's warnings: `public_base` must be on the host of `me` for `requireSocialSpec`, and caching on `public_base` can make the submission fail.

### SocialSpec profile

```ts
const server = await pups.discover(domain)
if (!server.wellKnownPaths.some(p => p.path == '/.well-known/about.md'))
  return showMessage('Your server does not allow apps to publish your profile.')
const session = await pups.loginWithPopup(server, { scopes: ['write:/.well-known/about.md'] })
if (!session.canWrite('/.well-known/about.md')) return showMessage('Profile access was not granted.')
await session.update('/.well-known/about.md', () => markdown)
```

### A blog feed (RFC-7)

```ts
const session = await pups.loginWithPopup(domain, { scopes: feedScopes() })
const feed = session.feed()
if ((await feed.load()).status == 'missing') await feed.create({ title: "Tim's Notes" })   // registers it in host-meta.json
await feed.addPost({ title: 'Hello', content_html: '<p>Hi!</p>' })
```

### An RFC-4 comment in the main feed

```ts
const { url } = await session.feed().addPost({ content_text: text, _source: { inReplyTo: target } })
await sendWebmention({ source: url, target })   // the archive URL + '#id', which never changes
```

## Requirements for apps

The documentation has one page with everything the app must provide:

1. **The client metadata document** on the app's own host, listing every redirect URI exactly. `pups.checkClientMetadata()` fetches it and reports: `client_id` not equal to the URL, `redirectUri` not listed, `client_uri` or `logo_uri` on another host than the client host (parent domains and other subdomains included), `localhost` redirects, missing CORS or wrong content type.
2. **A redirect URI page** that loads the library and calls `init()` or `handleRedirect()`. It should be minimal, load no third-party resources, and send `Referrer-Policy: no-referrer`.
3. **A Content Security Policy** that allows `connect-src` to any HTTPS origin (the user's server is unknown in advance), and keeps `script-src` strict.
4. **Telling the user what is public.** Everything written is public, including `/appdata/`. Apps must not upload secrets or private data.

**Local development.** RFC-6 accepts loopback redirect URIs (`http://127.0.0.1/…`, `http://[::1]/…`) from any app and ignores their port, because a server can't tell a native app from a browser app on a local dev server. The PUPS server still has to fetch the client metadata document, so that can't be on the developer's machine. Developers publish a development `client.json` on a public host, e.g. `https://app.example/oauth/dev-client.json`, that lists `http://127.0.0.1/callback`, and run the dev server on `127.0.0.1` with any port. The consent screen then tells the owner that the app runs on their computer. The library accepts an `http://127.0.0.1` or `http://[::1]` `redirectUri`, never `localhost`, and no other plain-HTTP URI. A development `client_id` should live on its own path, so production users never see a client that redirects to `127.0.0.1`.

## Command line tool

The package also contains `pups`, a command line tool built on the same core. It is a native app in RFC-6 terms and doubles as a test of the library outside the browser.

- **Client identity.** The user names a client domain they control, e.g. `tim.example.app`. The `client_id` is `https://<client-domain>/pups-cli.json` (or any URL given in full). `pups client-metadata <client-domain>` prints the document to publish there, listing `http://127.0.0.1/callback` and `http://[::1]/callback`; `pups check-client` verifies it, and `pups login` runs the same check first, because otherwise the server would show an error page and the CLI would wait in vain.
- **Login.** `pups login <domain> -c <client-domain>` listens on a random port of `127.0.0.1`, builds the authorization URL with `createAuthorization()` and redirect URI `http://127.0.0.1:<port>/callback`, opens the system browser (or prints the URL with `--no-browser`), receives the redirect, and finishes with `completeAuthorization()`. RFC-6 ignores the port of loopback redirects, so one entry in the client metadata document covers every port. The callback page has no scripts or external resources and sends `Referrer-Policy: no-referrer`.
- **Commands.** `whoami`, `put` (several files, `--to` file or directory, `-` for stdin, `--create`, `--if-match`, `--content-type`), `get`, `rm`, `url`, `link add|remove`, `property set`, `logout [--keep-grant]`, `sessions`. `--json` gives machine-readable output. Exit codes: 0 success, 1 error, 2 usage.
- **Credentials** are kept by `FileTokenStore` in `~/.config/pups/sessions.json` (or `$XDG_CONFIG_HOME/pups`, `$PUPS_CONFIG_DIR`), mode 0600 in a 0700 directory, written atomically through a temporary file. That is how tools like `gh` keep credentials; an OS keychain would need native dependencies.
- **Known limit.** Web Locks only coordinate within one process. Two `pups` processes refreshing the same session at once would make the server revoke the grant, so the documentation says not to run them in parallel, and `put` takes many files at once. A lock file would close this gap later.

## Package and project

```
pups-client/
  src/
    index.ts                  public exports only
    client.ts                 PupsClient
    session.ts                PupsSession, uploads, POST fallback
    host-meta.ts              HostMetaEditor
    discovery.ts
    oauth.ts
    scopes.ts
    paths.ts
    file-types.ts             extension table, shared with tests
    tokens.ts
    tabs.ts                   Web Locks + BroadcastChannel
    store/
      token-store.ts
      indexeddb-store.ts
      memory-store.ts
    errors.ts
    util.ts                   base64url, random, fetch with timeout
    cli/
      bin.ts                  the `pups` executable
      main.ts                 commands and options
      loopback.ts             native-app login through 127.0.0.1
      file-store.ts           FileTokenStore
  test/
    unit/                     every rule of paths, types, scopes, discovery, oauth
    integration/              against a mock PUPS server
    e2e/                      Playwright against the PUPS Cloudflare Worker
  examples/
    vanilla/                  one HTML file, no build step, loads from a CDN
    vite/                     a small app with login, upload, host-meta, logout
  docs/                       guides; API reference generated by TypeDoc
  README.md
  LICENSE                     MIT
  CHANGELOG.md
  package.json
  tsconfig.json
```

- **Build**: `tsc` emits ESM modules and declarations; a bundler can add a single-file build for CDNs later. ES2022, no polyfills, `sideEffects: false`.
- **Package**: `exports` with `types` and `import`; published to npm with provenance. Versions are `0.x` while RFC-6 is a draft; the README states which `spec_version` each release implements.
- **Code style**: strict TypeScript, short code, `==` where types match, no default exports.

## Documentation

- **README**: what PUPS is in three sentences, install, the quick start above, links.
- **Guides**: connecting an app (redirect vs popup), writing files and handling conflicts, sign-in with the domain (browser and backend), RFC-4 comments, SocialSpec profiles, `host-meta.json`, logout and revocation, security for app developers (storage threat model, CSP, callback page), local development, error reference.
- **API reference**: TypeDoc from TSDoc. Every exported symbol documents what it does, what it throws, and which RFC-6 section it implements, with a link.
- **Examples** that run as they are, and that the e2e tests run too.

## Testing

- **Unit** (Vitest, `fake-indexeddb`, mocked `fetch`): domain normalization, config validation, scope validation and `'appdata'` expansion, every path rule (including `%2e%2e`, `feed.php.json`, trailing dots, the `/.well-known/` exception), the extension table, PKCE against RFC 7636 test vectors, callback handling (`state`, `iss`, `error`), `me` verification including the rediscovery case, error mapping for each status.
- **Token lifecycle**: expiry and refresh, `401` retry exactly once, permanent vs temporary refresh failures, the multi-tab race (two simulated tabs refresh at once and the server sees exactly one refresh request), and a lost refresh response (the mock server rotates the token but drops the response; the retry within 60 seconds keeps the session).
- **Storage**: records are encrypted at rest (the raw IndexedDB value contains no token), the key is non-extractable, logout deletes before revoking.
- **Integration**: a mock PUPS server implementing RFC-6, including `post_endpoint` mode and a server without `host_meta_endpoint`.
- **End-to-end** (Playwright): full redirect and popup flows against the PUPS Cloudflare Worker, consent with dropped scopes, owner revocation detected by the client, two tabs, logout.

## Browser support

Required: `fetch`, Web Crypto (`subtle.digest`, AES-GCM), IndexedDB, `BroadcastChannel`, Web Locks. That is Chrome/Edge 69+, Firefox 96+, Safari 15.4+. Without Web Locks the library still works, with the reduced multi-tab protection described above.

## Open questions

- **Package name.** `pups-client` or a scope such as `@bigwide/pups-client`?
- **DPoP.** Once RFC-6 decides, add a non-extractable DPoP key to the session record.
- **Upload progress.** `fetch` has no upload progress. An `onProgress` option would need `XMLHttpRequest` for large media. Worth it in version 1?
- **Unconditional `put()`.** Keep it as a first-class method, or require an explicit `{ overwrite: true }` to steer apps towards `update()`?
- **Required scopes.** Should `login()` accept `requiredScopes` and fail if the owner drops one of them, or is checking `canWrite()` enough?
