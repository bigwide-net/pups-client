/**
 * pups-client: the reference client for Personal Upload Servers (PUPS, bigwide.net RFC-6).
 *
 * Sign the user in with their domain, and write files to it.
 * @packageDocumentation
 */
export { PupsClient, clientMetadataProblems } from './client.js'
export type {
  AuthorizationCode,
  ClientMetadataReport,
  LoginOptions,
  PendingAuthorization,
  PopupLoginOptions,
  PupsClientOptions,
  RedirectResult,
} from './client.js'
export { PupsSession } from './session.js'
export type { Body, JsonBody, SessionChangeEvent, StoredFile, WriteOptions, WriteResult } from './session.js'
export { FEED_REL, PUPS_FEED_SPEC, PupsFeed, feedScopes } from './feed.js'
export type {
  FeedAttachment,
  FeedAuthor,
  FeedDocument,
  FeedItem,
  FeedLink,
  FeedOptions,
  FeedSettings,
  FeedSettingsChanges,
  FeedSetup,
  FeedState,
  MediaInput,
  MediaResult,
  PostChanges,
  PostInput,
  PostResult,
  PupsMarker,
} from './feed.js'
export { HostMetaEditor } from './host-meta.js'
export type { HostMetaDocument, HostMetaLink } from './host-meta.js'
export { PupsError, isPupsError } from './errors.js'
export type { PupsErrorCode } from './errors.js'
export { PUPS_REL, SUPPORTED_SPEC_VERSIONS, normalizeDomain } from './discovery.js'
export type { PupsServer, WellKnownPath } from './discovery.js'
export type { Scope } from './scopes.js'
export { fileTypes, blockedExtensions } from './file-types.js'
export { IndexedDbTokenStore } from './store/indexeddb-store.js'
export type { IndexedDbTokenStoreOptions } from './store/indexeddb-store.js'
export { MemoryTokenStore } from './store/memory-store.js'
export type { SessionRecord, TokenStore } from './store/token-store.js'
