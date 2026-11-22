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
export { ARCHIVE_SPEC, FEED_REL, POST_URL_TEMPLATE, PUPS_FEED_SPEC, PupsFeed, feedScopes, itemIndex } from './feed.js'
export type {
  ArchiveFields,
  CommentPolicy,
  CommentsState,
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
  ItemArchive,
  ItemMarker,
  MentionChoice,
  MediaInput,
  MediaResult,
  PostChanges,
  PostInput,
  PostResult,
  PupsMarker,
} from './feed.js'
export { HostMetaEditor } from './host-meta.js'
export { PupsComments, commentFeedPath } from './comments.js'
export type { CommentChanges, CommentInput, CommentResult } from './comments.js'
export { MENTION_REL, Mentions } from './mentions.js'
export type { Delivery, DeliveryStatus, FoundItem, MentionReport, MentionSource, MentionsOptions, PlannedMention, PostChange, PostMentions, Submission, SubmissionStatus } from './mentions.js'
export { accountHost, findHandles, handleText, itemHandles, visibleText } from './handles.js'
export type { HandleSource } from './handles.js'
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
