import { isPupsError, PupsError } from './errors.js'
import { fileTypes } from './file-types.js'
import { pathFromPublicUrl } from './paths.js'
import { itemHandles } from './handles.js'
import type { Mentions, MentionReport, MentionSource, PlannedMention, Submission } from './mentions.js'
import type { Scope } from './scopes.js'
import type { Body, PupsSession } from './session.js'
import { isObject, randomString } from './util.js'

/** The link relation that registers a feed in `host-meta.json` (RFC-7). A placeholder in RFC-7. */
export const FEED_REL = 'https://bigwide.net/ns/feed'

/**
 * The site property in `host-meta.json` with the URL template of the pages that show single posts, e.g.
 * `https://tim.example/p/{feed}/post/{index}` (RFC-6 "Post URLs", RFC-7 "Post URLs").
 */
export const POST_URL_TEMPLATE = 'https://bigwide.net/ns/post-url-template'

/** The `about` of the `_pups` object: RFC-7. Not its final location; readers must not rely on it. */
export const PUPS_FEED_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md'

const RFC1_URL = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
const RFC4_URL = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md'
const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1'
const FEED_CONTENT_TYPE = 'application/feed+json'
const maxArchiveNumber = 999_999
/** The feed file keeps at least this many items, also when `maxBytes` is exceeded (RFC-7 "Size in bytes"). */
const minFeedItems = 10

const mainComment = `This feed is maintained by apps through a Personal Upload Server (PUPS), following ${PUPS_FEED_SPEC}. It contains the newest items. If it has _pups.archive_url, all items are in the archives, starting with the one there.`
const archiveComment = (feedUrl: string) =>
  `This is an archive of ${feedUrl}, maintained by apps through a Personal Upload Server (PUPS), following ${PUPS_FEED_SPEC}. New items appear in the feed at _pups.updates_url, older ones are in the archive at next_url.`

/** Feed names (RFC-7 "Named feeds"): 1 to 40 lowercase letters, digits and `-`, not starting or ending with `-`. */
const feedNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** The main feed's media directories in `/feed/`, which therefore can't be feed names. */
const mainMediaFolders = ['images', 'media']

/** Top-level fields that are fixed or managed by RFC-7, and can't be set through `create()` or `updateSettings()`. */
const reservedFields = new Set(['version', 'home_page_url', 'feed_url', 'user_comment', 'next_url', 'items', 'hubs', '_pups', 'icon', 'favicon'])

export interface FeedAuthor {
  name?: string
  url?: string
  avatar?: string
  [field: string]: unknown
}

export interface FeedAttachment {
  url: string
  mime_type: string
  title?: string
  size_in_bytes?: number
  duration_in_seconds?: number
  [field: string]: unknown
}

/** A JSON Feed 1.1 item. */
export interface FeedItem {
  id: string
  url?: string
  external_url?: string
  title?: string
  content_html?: string
  content_text?: string
  summary?: string
  image?: string
  banner_image?: string
  date_published?: string
  date_modified?: string
  authors?: FeedAuthor[]
  tags?: string[]
  language?: string
  attachments?: FeedAttachment[]
  /** The item's `_pups` object, with its index (RFC-7 "Indexes"). */
  _pups?: ItemMarker
  [field: string]: unknown
}

/** The `_pups` object of an item. */
export interface ItemMarker {
  /** The item's index: 0 for a feed's first item, then counting up; never changed, never used again (RFC-7 "Indexes"). */
  index?: number
  [field: string]: unknown
}

/** The `_pups` object of a feed file or archive. */
export interface PupsMarker {
  about?: string
  pupsControlled?: boolean
  /** In the feed file: the public URL of the newest archive. */
  archive_url?: string
  /** In an archive: the public URL of the feed file, which readers poll. */
  updates_url?: string
  /**
   * The index the next new item gets (RFC-7 "Indexes"). Valid in the newest archive, or in the feed file of a feed
   * without archives.
   */
  next_index?: number
  [field: string]: unknown
}

/** A JSON Feed 1.1 document, as stored in a feed file or archive. */
export interface FeedDocument {
  version: string
  title: string
  home_page_url?: string
  feed_url?: string
  description?: string
  user_comment?: string
  next_url?: string
  icon?: string
  favicon?: string
  authors?: FeedAuthor[]
  language?: string
  expired?: boolean
  hubs?: unknown[]
  items: FeedItem[]
  _pups?: PupsMarker
  [field: string]: unknown
}

/**
 * The fields of a feed that belong to the owner (RFC-7 "Fields"). Extensions such as `_podcast` (RFC-3) or
 * `_source` (RFC-1) are allowed too. Icons are set with `setIcon()` and `setFavicon()`.
 */
export interface FeedSettings {
  title?: string
  description?: string
  authors?: FeedAuthor[]
  language?: string
  expired?: boolean
  [extension: `_${string}`]: unknown
}

/**
 * The rules for comments of RFC-4 "Policies". Missing rules have RFC-4's defaults; servers may add others. The PUPS
 * server's receiver enforces `title`, `minLength`, `maxLength`, `requireSocialSpec`, `allowEdit` and `allowDelete`.
 */
export interface CommentPolicy {
  title?: 'required' | 'allowed' | 'none'
  minLength?: number
  maxLength?: number
  requireSocialSpec?: boolean
  allowEdit?: boolean
  allowDelete?: boolean
  [rule: string]: unknown
}

/**
 * Whether a feed accepts comments (RFC-4 `_submissions`): `pups` through the PUPS server's receiver, `other`
 * through another service, such as an rssmention server, or `off`.
 */
export type CommentsState = 'pups' | 'other' | 'off'

/** Changes to the settings: a value sets the field, `null` removes it, `undefined` leaves it unchanged. */
export type FeedSettingsChanges = { [K in keyof FeedSettings]?: FeedSettings[K] | null }

/**
 * An image, audio or video file to upload: a `Blob` (or `File`) with a type or name, or a body with its type or
 * extension. The extension must be on the RFC-6 allowlist.
 */
export type MediaInput = Blob | { body: Body; type?: string; extension?: string }

/** The settings of a new feed. */
export interface FeedSetup extends FeedSettings {
  title: string
  /** 512 × 512 pixels, stored in `images/icons/` in the feed directory. */
  icon?: MediaInput
  /** 64 × 64 pixels, stored in `images/icons/` in the feed directory. */
  favicon?: MediaInput
}

/** A new post: a JSON Feed item without `id` (generated unless given) and with a few conveniences. */
export interface PostInput {
  /** Generated if missing: 16 random URL-safe characters. Must be unique across the feed and its archives. */
  id?: string
  title?: string
  content_html?: string
  content_text?: string
  /**
   * The text as Markdown, stored in `_source.markdown` (RFC-1). If neither `content_html` nor `content_text` is
   * given, the Markdown is also used as `content_text`, since JSON Feed requires one of them.
   */
  markdown?: string
  summary?: string
  url?: string
  external_url?: string
  image?: string
  banner_image?: string
  /** Default: now. */
  date_published?: string | Date
  authors?: FeedAuthor[]
  tags?: string[]
  language?: string
  attachments?: FeedAttachment[]
  [extension: `_${string}`]: unknown
}

/** Changes to a post: a value sets the field, `null` removes it, `undefined` leaves it unchanged. */
export type PostChanges = { [K in Exclude<keyof PostInput, 'id'>]?: PostInput[K] | null }

export interface PostResult {
  id: string
  /** The item's index (RFC-7 "Indexes"); undefined for an item that has none yet. */
  index?: number
  /** The item as stored. */
  item: FeedItem
  /**
   * The URL of the item's archive plus `#<id>`. Items never leave their archive, so it never changes; use it e.g.
   * as the `source` of an RFC-4 webmention. In a feed without archives, the feed file's URL plus `#<id>`.
   */
  url: string
  /**
   * With the option `mentions`: the RFC-11 mentions, sent once the post is visible at its public URL. Never
   * rejects. Missing if the post names and answers no one.
   */
  mentions?: Promise<MentionReport[]>
}

export interface MediaResult {
  path: string
  /** The public URL, to reference from items. */
  url: string
  /** The served type, e.g. for `attachments[].mime_type`. */
  type: string
  size: number
}

export type FeedState =
  /** There is no feed file yet. `create()` sets it up. */
  | { status: 'missing' }
  /** A feed maintained by PUPS clients, ready to write. */
  | { status: 'pups'; feed: FeedDocument; etag: string }
  /** A JSON Feed without `_pups.pupsControlled`: maintained by other means, and never written (RFC-7). */
  | { status: 'foreign'; feed: FeedDocument }
  /** The file exists but is not a JSON Feed. */
  | { status: 'invalid' }

export interface FeedOptions {
  /** How many of the newest items the feed file holds. Default 30 (RFC-7 "Feed size"). */
  maxItems?: number
  /** How many items an archive holds. Default 20 (RFC-7 "Archives"); other clients expect 20. */
  archiveSize?: number
  /**
   * Whether to start archives for a feed that has none, on its next post (RFC-7 "Starting the archives").
   * Default true. With false, posts to such a feed only go into the feed file, and items beyond `maxItems` are
   * dropped. Feeds that have archives always keep them.
   */
  startArchives?: boolean
  /**
   * Optional: keep fewer items in the feed file when it would be larger than this many bytes, but at least 10
   * (RFC-7 "Size in bytes").
   */
  maxBytes?: number
  /** How often an operation is repeated when another client changed the feed in between. Default 8. */
  maxAttempts?: number
  /**
   * Whether posts of a feed with archives get a `url` from the site's post URL template, if `host-meta.json`
   * declares one and the post has no `url` (RFC-7 "Post URLs"). Default true.
   */
  postUrls?: boolean
  /**
   * Whether to send RFC-11 mentions after `addPost()`, `editPost()` and `deletePost()`: to the domains a post names
   * (`@tim.example.com`) and to the author of the item it answers. `true` uses `session.mentions`. Default false.
   * Each write can decide otherwise with its own option `mentions`, e.g. with the accounts the author confirmed.
   */
  mentions?: boolean | Mentions
}

/** A feed registered in `host-meta.json`. */
export interface FeedLink {
  /** The public URL of the feed file. */
  url: string
  type?: string
  /** Set if the feed is a main or named feed on this PUPS server, in the layout of RFC-7. */
  feed?: PupsFeed
}

type Signal = { signal?: AbortSignal }

/**
 * Which RFC-11 mentions a write sends: `true` all of them, `false` none, or a list from `planMentions()`, e.g. the
 * accounts the author confirmed. Default: the feed's option `mentions`.
 */
export type MentionChoice = boolean | PlannedMention[]
type WithMentions = Signal & { mentions?: MentionChoice }

interface Loaded {
  path: string
  doc: FeedDocument
  etag: string
}

interface Found {
  main: Loaded
  file: Loaded
  index: number
}

/** The scopes an app needs to write a feed: the feed file and the feed directory (RFC-7 "Server requirements"). */
export function feedScopes(name?: string): Scope[] {
  const { path, directory } = feedPaths(name)
  return [`write:${path}`, `write:${directory}`]
}

function feedPaths(name?: string): { path: `/${string}`; directory: `/${string}` } {
  if (name === undefined) return { path: '/feed.json', directory: '/feed/' }
  if (!feedNamePattern.test(name))
    throw new PupsError('invalid_request', `"${name}" is not a valid feed name: use 1 to 40 lowercase letters, digits and "-", not starting or ending with "-" (RFC-7, Named feeds).`)
  if (mainMediaFolders.includes(name))
    throw new PupsError('invalid_request', `"${name}" can't be a feed name: /feed/${name}/ and its files belong to the main feed (RFC-7, Named feeds).`)
  return { path: `/feed/${name}.json`, directory: `/feed/${name}/` }
}


const isFeedDocument = (value: unknown): value is FeedDocument =>
  isObject(value) && typeof value.version == 'string' && value.version.startsWith('https://jsonfeed.org/version/1')
  && Array.isArray(value.items) && value.items.every(i => isObject(i) && typeof i.id == 'string')

const isControlled = (doc: FeedDocument) => doc._pups?.pupsControlled === true

const notControlled = (path: string) =>
  new PupsError('not_pups_controlled', `${path} is not maintained by PUPS clients: it has no "_pups": { "pupsControlled": true }. It is never written; the owner can hand it over by adding that marker (RFC-7, The _pups object).`)

const conflict = (what: string) => new PupsError('precondition_failed', `${what} changed in the meantime.`)

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const clone = <T>(value: T): T => structuredClone(value)

const serialize = (doc: FeedDocument) => JSON.stringify(doc, null, 2)

const byteLength = (text: string) => new TextEncoder().encode(text).length

const replaceAt = <T>(array: T[], index: number, value: T) => array.map((v, i) => i == index ? value : v)

/** Adds `incoming` items at the top of `existing`; an item whose id is already there replaces the old copy instead. */
function mergeItems(existing: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  const byId = new Map(incoming.map(item => [item.id, item]))
  const present = new Set(existing.map(item => item.id))
  return [...incoming.filter(item => !present.has(item.id)), ...existing.map(item => byId.get(item.id) ?? item)]
}

/** The index of an item (RFC-7 "Indexes"), or undefined if it has none. */
export function itemIndex(item: FeedItem): number | undefined {
  const index = isObject(item._pups) ? item._pups.index : undefined
  return typeof index == 'number' && Number.isSafeInteger(index) && index >= 0 ? index : undefined
}

const withIndex = (item: FeedItem, index: number): FeedItem => ({ ...item, _pups: { ...isObject(item._pups) ? item._pups : {}, index } })

/** A post URL template (RFC-6 "Post URLs"): an https URL with `{index}` or `{id}`. */
function validTemplate(template: unknown): template is string {
  if (typeof template != 'string' || !/\{(index|id)\}/.test(template)) return false
  try {
    return new URL(template.replace(/\{(feed|index|id)\}/g, 'x')).protocol == 'https:'
  } catch {
    return false
  }
}

/** The counter `_pups.next_index` of a file, if it has a valid one. */
function counterOf(doc: FeedDocument): number | undefined {
  const next = doc._pups?.next_index
  return typeof next == 'number' && Number.isSafeInteger(next) && next >= 0 ? next : undefined
}

/** The next free index: above every index of `items`, and at least each of `counters`. */
const nextFree = (items: FeedItem[], ...counters: (number | undefined)[]) =>
  Math.max(0, ...counters.filter((c): c is number => c !== undefined), ...items.map(item => (itemIndex(item) ?? -1) + 1))

/**
 * Gives the items without an index (newest first, as in a file) the next indexes from `next`, the oldest first
 * (RFC-7 "Items without an index").
 * @returns the items, and the counter after them.
 */
function indexItems(items: FeedItem[], next: number): { items: FeedItem[]; next: number; changed: boolean } {
  const result = [...items]
  let changed = false
  for (let i = result.length - 1; i >= 0; i--)
    if (itemIndex(result[i]!) === undefined) {
      result[i] = withIndex(result[i]!, next++)
      changed = true
    }
  return { items: result, next, changed }
}

/** Every string inside `value`, deeply. */
function* strings(value: unknown): Generator<string> {
  if (typeof value == 'string') yield value
  else if (Array.isArray(value)) for (const v of value) yield* strings(v)
  else if (isObject(value)) for (const v of Object.values(value)) yield* strings(v)
}

/** The file extension for a media type, preferring extensions that are served as exactly that type. */
function extensionForType(type: string): string | undefined {
  const essence = type.split(';')[0]!.trim().toLowerCase()
  const entries = Object.entries(fileTypes)
  return entries.find(([, t]) => t.served == essence)?.[0] ?? entries.find(([, t]) => t.accepted.includes(essence))?.[0]
}

/**
 * A feed on the owner's domain, maintained according to RFC-7: the main feed `/feed.json`, or a named feed
 * `/feed/<name>.json`, each with its feed directory for archives, icons and media: `/feed/`, or `/feed/<name>/`.
 * The main feed keeps its media in `/feed/images/` and `/feed/media/`, since the rest of `/feed/` belongs to the
 * named feeds.
 *
 * Get one from `session.feed()` or `session.feed('photos')`. The session needs the feed's scopes, see
 * {@link feedScopes}. All writes are safe against concurrent changes by other apps and the owner: they are
 * read-modify-write cycles with ETags, repeated when another client wrote in between.
 */
export class PupsFeed {
  /** The name of a named feed; undefined for the main feed. */
  readonly name?: string
  /** The feed file, e.g. `/feed.json` or `/feed/photos.json`. */
  readonly path: string
  /** The feed directory, e.g. `/feed/` or `/feed/photos/`. */
  readonly directory: string
  readonly #session: PupsSession
  readonly #maxItems: number
  readonly #archiveSize: number
  readonly #archivesWanted: boolean
  readonly #maxBytes?: number
  readonly #maxAttempts: number
  readonly #postUrls: boolean
  readonly #mentions?: Mentions
  #template?: Promise<string | undefined>

  /** @internal Use `session.feed()`. */
  constructor(session: PupsSession, name?: string, options: FeedOptions = {}) {
    const { path, directory } = feedPaths(name)
    this.name = name
    this.path = path
    this.directory = directory
    this.#session = session
    this.#maxItems = options.maxItems ?? 30
    this.#archiveSize = options.archiveSize ?? 20
    this.#archivesWanted = options.startArchives ?? true
    this.#maxBytes = options.maxBytes
    this.#maxAttempts = options.maxAttempts ?? 8
    this.#postUrls = options.postUrls ?? true
    this.#mentions = options.mentions === true ? session.mentions : options.mentions || undefined
    if (!(this.#archiveSize >= 1 && this.#maxItems >= 1))
      throw new PupsError('invalid_request', 'Feed options: maxItems and archiveSize must be at least 1.')
  }

  /** The public URL of the feed file, its `feed_url`. */
  get url(): string {
    return this.#session.publicUrl(this.path)
  }

  /** The scopes needed to write this feed. */
  get scopes(): Scope[] {
    return feedScopes(this.name)
  }

  /** Whether the session may write the feed file and the feed directory. */
  get writable(): boolean {
    return this.#session.canWrite(this.path) && this.#session.canWrite(this.#archivePath(0))
  }

  /** Reads the feed file and tells whether it exists, and whether PUPS clients may write it. */
  async load(options: Signal = {}): Promise<FeedState> {
    try {
      const loaded = await this.#read(this.path, options.signal)
      if (!loaded) return { status: 'missing' }
      return isControlled(loaded.doc) ? { status: 'pups', feed: loaded.doc, etag: loaded.etag } : { status: 'foreign', feed: loaded.doc }
    } catch (e) {
      if (isPupsError(e, 'invalid_feed')) return { status: 'invalid' }
      throw e
    }
  }

  /**
   * Sets up a new feed (RFC-7 "Setting up a feed"): uploads the icons, writes the feed file with the fixed fields
   * and the `_pups` marker, and registers the feed in `host-meta.json` (unless `register` is false).
   * @returns `registered`: false if the feed couldn't be registered; call `register()` again later, or tell the owner
   *   to add the link to `host-meta.json` by hand.
   * @throws {PupsError} `precondition_failed` if the feed file exists already; `insufficient_scope`.
   */
  async create(setup: FeedSetup, options: Signal & { register?: boolean } = {}): Promise<{ url: string; registered: boolean }> {
    const { icon, favicon, title, ...settings } = setup
    if (typeof title != 'string' || !title.trim()) throw new PupsError('invalid_request', 'A feed needs a title.')
    this.#checkSettings(settings)
    this.#checkWritable()
    const uploaded: MediaResult[] = []
    try {
      const iconFile = icon && await this.#upload(icon, 'images/icons/icon-', options.signal)
      if (iconFile) uploaded.push(iconFile)
      const faviconFile = favicon && await this.#upload(favicon, 'images/icons/favicon-', options.signal)
      if (faviconFile) uploaded.push(faviconFile)
      const { description, ...rest } = settings
      const doc: FeedDocument = {
        version: JSON_FEED_VERSION,
        title,
        home_page_url: this.#session.me,
        feed_url: this.url,
        ...description === undefined ? {} : { description },
        user_comment: mainComment,
        ...iconFile ? { icon: iconFile.url } : {},
        ...faviconFile ? { favicon: faviconFile.url } : {},
        ...rest,
        items: [],
        _pups: { about: PUPS_FEED_SPEC, pupsControlled: true },
      }
      await this.#session.create(this.path, serialize(doc), { contentType: FEED_CONTENT_TYPE, signal: options.signal })
    } catch (e) {
      await Promise.all(uploaded.map(file => this.#deleteQuietly(file.path)))
      if (isPupsError(e, 'precondition_failed'))
        throw new PupsError('precondition_failed', `${this.path} exists already. Use load() to see whether it can be used.`, { cause: e })
      throw e
    }
    if (options.register === false) return { url: this.url, registered: false }
    try {
      return { url: this.url, registered: await this.register(options) }
    } catch (e) {
      // The feed exists now; a failed registration must not look like a failed setup.
      if (isPupsError(e, 'aborted')) throw e
      return { url: this.url, registered: false }
    }
  }

  /**
   * Registers the feed in `host-meta.json` (RFC-7 "Registering feeds"), unless a link with the feed relation and
   * this feed's URL exists already.
   * @returns false if the server has no host-meta endpoint, or doesn't allow the feed relation for this path.
   */
  async register(options: Signal = {}): Promise<boolean> {
    const hostMeta = this.#session.hostMeta
    if (!hostMeta.available || !hostMeta.allowsRel(FEED_REL, this.path)) return false
    const document = await hostMeta.get(options)
    if (document.links?.some(link => link.rel == FEED_REL && link.href == this.url)) return true
    await hostMeta.addLink({ rel: FEED_REL, href: this.path, type: FEED_CONTENT_TYPE }, options)
    return true
  }

  /**
   * Changes the owner's fields of the feed (RFC-7 "Editing a feed"): a value sets a field, `null` removes it.
   * @returns the feed as written.
   */
  async updateSettings(changes: FeedSettingsChanges, options: Signal = {}): Promise<FeedDocument> {
    this.#checkSettings(changes)
    if (changes.title === null || (changes.title !== undefined && !changes.title.trim()))
      throw new PupsError('invalid_request', 'A feed needs a title.')
    return this.#transaction(async () => {
      const main = await this.#readControlled(this.path, options.signal)
      const doc = { ...main.doc }
      for (const [key, value] of Object.entries(changes))
        if (value === null) delete doc[key]
        else if (value !== undefined) doc[key] = value
      return this.#writeMain(doc, main.etag, options.signal)
    })
  }

  /**
   * Uploads a new icon (512 × 512) to `/feed/images/icons/` (`/feed/<name>/images/icons/` for a named feed) and
   * deletes the old one, or removes it with `null`.
   */
  setIcon(media: MediaInput | null, options: Signal = {}): Promise<FeedDocument> {
    return this.#setImage('icon', media, options.signal)
  }

  /** Uploads a new favicon (64 × 64) to the icons directory, like `setIcon()`, or removes it with `null`. */
  setFavicon(media: MediaInput | null, options: Signal = {}): Promise<FeedDocument> {
    return this.#setImage('favicon', media, options.signal)
  }

  /** Whether the PUPS server can receive comments on the feed's posts (`comment_endpoint`, RFC-6 "Built-in receiver"). */
  get commentsAvailable(): boolean {
    return !!this.#session.server.commentEndpoint
  }

  /** Whether the feed accepts comments, and through whom; `doc` is the feed file, e.g. from `load()`. */
  comments(doc: FeedDocument): CommentsState {
    const submissions = doc._submissions
    if (!isObject(submissions)) return 'off'
    const endpoint = this.#session.server.commentEndpoint
    return endpoint && submissions.url == endpoint ? 'pups' : 'other'
  }

  /**
   * Lets readers comment on the feed's posts through the PUPS server, which puts the comments into the owner's inbox
   * (RFC-6 "Built-in receiver"): writes RFC-4 `_submissions` into the feed file, with `comment_endpoint` as `url`,
   * the comments policy (RFC-4's defaults for `title`, `minLength` and `maxLength`, overridden by `policy`) and
   * `republish: "no"`. Replaces the `_submissions` of another service; check `comments()` first and ask the owner.
   * Single posts are closed with `_commenting: { allowComments: false }` (RFC-4).
   * @throws {PupsError} `unsupported` if the server has no `comment_endpoint`.
   */
  async enableComments(settings: { policy?: CommentPolicy; tos?: string } = {}, options: Signal = {}): Promise<FeedDocument> {
    const url = this.#session.server.commentEndpoint
    if (!url) throw new PupsError('unsupported', 'This PUPS server doesn\'t receive comments: its configuration has no comment_endpoint (RFC-6, Built-in receiver).')
    return this.#setSubmissions({
      about: RFC4_URL,
      url,
      ...settings.tos ? { tos: settings.tos } : {},
      policies: { comments: { title: 'none', minLength: 2, maxLength: 2000, ...settings.policy } },
      republish: 'no',
    }, options.signal)
  }

  /** Closes the feed for comments: removes `_submissions` from the feed file, whichever service it names. */
  disableComments(options: Signal = {}): Promise<FeedDocument> {
    return this.#setSubmissions(undefined, options.signal)
  }

  #setSubmissions(submissions: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<FeedDocument> {
    return this.#transaction(async () => {
      const main = await this.#readControlled(this.path, signal)
      const { _submissions: _old, ...doc } = main.doc
      return this.#writeMain(submissions ? { ...doc, _submissions: submissions } : doc, main.etag, signal)
    })
  }

  /**
   * Uploads an image, audio or video file into the feed directory under a new, unique name, by default
   * `images/<year>/…` for images and `media/<year>/…` for everything else. Reference it from a post by its `url`.
   * For the main feed, `folder` must be inside `images/` or `media/`: the rest of `/feed/` belongs to named feeds.
   */
  async uploadMedia(media: MediaInput, options: Signal & { folder?: string } = {}): Promise<MediaResult> {
    const { type } = this.#mediaType(media)
    const folder = (options.folder ?? (type.startsWith('image/') ? 'images' : 'media')).replace(/^\/+|\/+$/g, '')
    if (folder == 'images/icons' || folder.startsWith('images/icons/'))
      throw new PupsError('invalid_request', `${this.directory}images/icons/ is reserved for the feed's icons (RFC-7, Icons).`)
    if (this.name === undefined && !mainMediaFolders.includes(folder.split('/')[0]!))
      throw new PupsError('invalid_request', `The main feed's media go into /feed/images/ or /feed/media/; the rest of /feed/ belongs to named feeds (RFC-7, Items).`)
    return this.#upload(media, `${folder}/${new Date().getUTCFullYear()}/`, options.signal)
  }

  /**
   * Adds a post (RFC-7 "Posting with archives"): first to the newest archive, or to a new archive once the newest
   * holds `archiveSize` items, then to the top of the feed file, which keeps the newest `maxItems`. A feed without
   * archives gets them now, unless `startArchives` is false; then the post only goes into the feed file. Upload
   * media with `uploadMedia()` before posting.
   * In a feed with archives, a post without `url` gets one from the site's post URL template, if `host-meta.json`
   * has one and `postUrls` isn't false: the page that shows the post (RFC-7 "Post URLs").
   * With the option `mentions`, the domains the post names and the author of the item it answers are notified
   * (RFC-11) once the post is visible; see `PostResult.mentions`.
   * @returns the post, with `url`: its archive's URL plus `#<id>`, which never changes; for a feed without
   *   archives, the feed file's URL plus `#<id>`, valid while the post is among the newest. The post's page, if it
   *   has one, is `item.url`.
   */
  async addPost(input: PostInput, options: WithMentions = {}): Promise<PostResult> {
    const item = this.#newItem(input)
    const signal = options.signal
    let archiveUrl = ''
    let stored = item
    let firstAttempt = true
    await this.#transaction(async () => {
      const main = await this.#readControlled(this.path, signal)
      // On a retry, the item may be in the feed file already: another client repaired it from the archive.
      if (firstAttempt && main.doc.items.some(i => i.id == item.id))
        throw new PupsError('invalid_request', `The feed already has an item with the id "${item.id}".`)
      firstAttempt = false
      const doc: FeedDocument = { ...main.doc, _pups: { ...main.doc._pups } }
      const hasArchives = this.#archiveNumber(doc._pups!.archive_url) !== undefined
      if (!hasArchives && !this.#archivesWanted) {
        // A feed without archives: the feed file is all there is, and holds the counter (RFC-7 "Posting").
        archiveUrl = this.url
        const indexed = indexItems(doc.items, nextFree(doc.items, counterOf(doc)))
        stored = withIndex(item, indexed.next)
        doc._pups!.next_index = indexed.next + 1
        await this.#writeMain({ ...doc, items: this.#newestItems([stored], indexed.items, doc) }, main.etag, signal)
        return
      }
      if (!hasArchives) {
        const started = await this.#startArchives(main, signal)
        if (started) {
          doc._pups!.archive_url = started.url
          doc.items = started.items
        }
      }
      const template = await this.#postUrlTemplate(signal)
      const added = await this.#addToArchive(main, doc, item, signal, template)
      archiveUrl = added.url
      stored = added.item
      doc._pups!.archive_url = added.url
      if (!hasArchives) {
        // The old chain of a handed-over feed now continues behind the oldest archive, and the newest archive
        // holds the counter.
        delete doc.next_url
        delete doc._pups!.next_index
      }
      doc.items = this.#newestItems(added.recent, doc.items, doc)
      await this.#writeMain(doc, main.etag, signal)
    })
    return this.#withMentions(options.mentions, this.#result(stored, archiveUrl), archiveUrl, stored, undefined, item => !!item)
  }

  /**
   * Gives every item of the feed without an index one (RFC-7 "Indexing an existing feed"), and sets the counter.
   * `addPost()` does this by itself before the first post to a feed that hasn't been indexed yet; call it to
   * index a feed without posting.
   */
  async assignIndexes(options: Signal = {}): Promise<void> {
    const signal = options.signal
    await this.#transaction(async () => {
      const main = await this.#readControlled(this.path, signal)
      const newest = this.#archiveNumber(main.doc._pups?.archive_url)
      if (newest === undefined) {
        const indexed = indexItems(main.doc.items, nextFree(main.doc.items, counterOf(main.doc)))
        if (indexed.changed || counterOf(main.doc) !== indexed.next)
          await this.#writeMain({ ...main.doc, items: indexed.items, _pups: { ...main.doc._pups, next_index: indexed.next } }, main.etag, signal)
        return
      }
      const archive = await this.#readArchive(this.#archivePath(newest), signal)
      if (archive && archive != 'foreign' && (counterOf(archive.doc) === undefined || archive.doc.items.some(item => itemIndex(item) === undefined)))
        await this.#indexArchives(main, signal)
    })
  }

  /**
   * Finds a post by id in the archives (or, for a handed-over feed without archives yet, in the feed file).
   * @returns undefined if there is no such post.
   */
  async getPost(id: string, options: Signal = {}): Promise<PostResult | undefined> {
    const main = await this.#read(this.path, options.signal)
    const found = main && await this.#find(main, id, options.signal)
    return found && this.#result(found.file.doc.items[found.index]!, this.#session.publicUrl(found.file.path))
  }

  /**
   * All posts, newest first: the archives from `_pups.archive_url` along `next_url` (for a feed without archives,
   * the feed file and its `next_url` chain). Each post is returned once.
   */
  async *posts(options: Signal = {}): AsyncGenerator<FeedItem> {
    const main = await this.#read(this.path, options.signal)
    if (!main) return
    const seen = new Set<string>()
    for await (const file of this.#chain(main, options.signal))
      for (const item of file.doc.items)
        if (!seen.has(item.id)) {
          seen.add(item.id)
          yield item
        }
  }

  /**
   * Edits a post in its archive, and in the feed file if it is among the newest items (RFC-7 "Editing and deleting
   * items"), and sets `date_modified`. `changes` is either an object (a value sets a field, `null` removes it), or
   * a function that gets a copy of the item and returns the new item, or `undefined` to leave it unchanged. The
   * function may run more than once.
   *
   * Apps should edit posts only when the owner asks them to, whichever app created them. With the option
   * `mentions`, everyone the old or the new version mentions is notified. A post of a feed with
   * archives that has no `url`, and had none before, gets one from the post URL template, as in `addPost()`.
   * @throws {PupsError} `not_found`
   */
  async editPost(id: string, changes: PostChanges | ((item: FeedItem) => FeedItem | undefined | Promise<FeedItem | undefined>), options: WithMentions = {}): Promise<PostResult> {
    const signal = options.signal
    let edit: { old: FeedItem; item: FeedItem; fileUrl: string } | undefined
    const result = await this.#transaction(async () => {
      edit = undefined
      const { main, file, index } = await this.#findWritable(id, signal)
      const old = file.doc.items[index]!
      const fileUrl = this.#session.publicUrl(file.path)
      const changed = typeof changes == 'function' ? await changes(clone(old)) : this.#applyChanges(clone(old), changes)
      if (!changed) return this.#result(old, fileUrl)
      const oldIndex = itemIndex(old)
      let item: FeedItem = { ...changed, id, date_modified: now() }
      // The index never changes (RFC-7 "Indexes").
      if (oldIndex !== undefined) item = withIndex(item, oldIndex)
      // A post of a feed with archives that never had a url may get one (RFC-7 "Post URLs").
      if (oldIndex !== undefined && !old.url && !item.url && this.#archiveNumber(main.doc._pups?.archive_url) !== undefined)
        item = this.#withPostUrl(item, oldIndex, await this.#postUrlTemplate(signal))
      if (file != main) await this.#writeArchive(file, replaceAt(file.doc.items, index, item), signal)
      const mainIndex = main.doc.items.findIndex(i => i.id == id)
      if (mainIndex >= 0) await this.#writeMain({ ...main.doc, items: replaceAt(main.doc.items, mainIndex, item) }, main.etag, signal)
      edit = { old, item, fileUrl }
      return this.#result(item, fileUrl)
    })
    const done = edit as typeof edit
    return done ? this.#withMentions(options.mentions, result, done.fileUrl, done.item, done.old, found => found?.date_modified == done.item.date_modified) : result
  }

  /**
   * Deletes a post from its archive and from the feed file, which is then filled up again with the newest items
   * from the archives. With `deleteMedia`, it also deletes the files in the feed directory that the post references
   * and no other post does; this reads all archives.
   * @returns the deleted item, and the public URLs of the deleted media files.
   * @throws {PupsError} `not_found`
   */
  async deletePost(id: string, options: WithMentions & { deleteMedia?: boolean } = {}): Promise<{ item: FeedItem; deletedMedia: string[]; mentions?: Promise<MentionReport[]> }> {
    const signal = options.signal
    let fileUrl = ''
    const item = await this.#transaction(async () => {
      const { main, file, index } = await this.#findWritable(id, signal)
      fileUrl = this.#session.publicUrl(file.path)
      const item = file.doc.items[index]!
      if (file != main) {
        await this.#writeArchive(file, file.doc.items.filter(i => i.id != id), signal)
        // Fill the feed file up again from the archives, which no longer contain the item.
        const newest: FeedItem[] = []
        for await (const archive of this.#chain(main, signal)) {
          newest.push(...archive.doc.items.filter(i => i.id != id))
          if (newest.length >= this.#maxItems) break
        }
        await this.#writeMain({ ...main.doc, items: this.#newestItems(newest, [], main.doc) }, main.etag, signal)
      } else
        await this.#writeMain({ ...main.doc, items: main.doc.items.filter(i => i.id != id) }, main.etag, signal)
      return item
    })
    const deletedMedia: string[] = []
    if (options.deleteMedia) {
      const candidates = new Set(this.#mediaUrls(item))
      if (candidates.size)
        for await (const other of this.posts(options))
          for (const url of this.#mediaUrls(other)) candidates.delete(url)
      for (const url of candidates) {
        const path = pathFromPublicUrl(this.#session.server, url)
        if (path && await this.#deleteQuietly(path, signal)) deletedMedia.push(url)
      }
    }
    const mentions = this.#sendMentions(options.mentions, fileUrl, undefined, item, found => !found)
    return { item, deletedMedia, ...mentions ? { mentions } : {} }
  }

  /**
   * Sends the RFC-11 mentions of a post now, e.g. to try again those that failed (see `Mentions.notifyAll()`). With
   * `previous`, the version before an edit, also to the accounts that one mentioned.
   * @throws {PupsError} `not_found`
   */
  async sendMentions(id: string, options: Signal & { previous?: FeedItem } = {}): Promise<MentionReport[]> {
    const post = await this.getPost(id, options)
    if (!post) throw new PupsError('not_found', `The feed has no post with the id "${id}".`)
    return this.#mentionSender.notifyAll({ source: post.url, item: post.item, previous: options.previous, me: this.#session.me }, options)
  }

  /**
   * Submits a post that answers an item of an RFC-4 feed, e.g. a comment, to that feed's `_submissions.url`
   * (RFC-4 "Submitting"): `source` is the post's archive URL plus `#<id>`, `target` its `_source.inReplyTo`. Call it
   * after `addPost()` or `editPost()`, also to submit an edit or a delete again. Show the target's terms of service
   * and what its `republish` means before the first submission.
   * @throws {PupsError} `not_found`; `invalid_request` if the post answers nothing; `unsupported` if the target
   *   feed takes no submissions.
   */
  async submit(id: string, options: Signal = {}): Promise<Submission> {
    const post = await this.getPost(id, options)
    if (!post) throw new PupsError('not_found', `The feed has no post with the id "${id}".`)
    const source = isObject(post.item._source) ? post.item._source : {}
    if (typeof source.inReplyTo != 'string') throw new PupsError('invalid_request', `The post "${id}" has no _source.inReplyTo, so it answers nothing (RFC-4).`)
    return this.#session.mentions.submit(post.url, source.inReplyTo, options)
  }

  /**
   * The RFC-11 mentions a post would send (see `Mentions.plan()`), e.g. to ask the author before posting:
   *
   * ```ts
   * const planned = await feed.planMentions(input)
   * const confirmed = planned.length && await askToNotify(planned) ? planned : false   // the app's dialog
   * await feed.addPost(input, { mentions: confirmed })
   * ```
   *
   * For an edit, pass the post as it will be and the current version as `previous`; for a delete, only `previous`.
   */
  planMentions(post: MentionSource | undefined, options: Signal & { previous?: MentionSource; discover?: boolean } = {}): Promise<PlannedMention[]> {
    return this.#mentionSender.plan({ item: post, previous: options.previous, me: this.#session.me }, options)
  }

  get #mentionSender(): Mentions {
    return this.#mentions ?? this.#session.mentions
  }

  /** The result with the RFC-11 mentions of the post, if the write sends them (see `#sendMentions()`). */
  #withMentions(choice: MentionChoice | undefined, result: PostResult, fileUrl: string, item: FeedItem, previous: FeedItem | undefined, ready: (item?: FeedItem) => boolean): PostResult {
    const mentions = this.#sendMentions(choice, fileUrl, item, previous, ready)
    return mentions ? { ...result, mentions } : result
  }

  /**
   * Sends the RFC-11 mentions of a post in the background, once its file at `fileUrl` is in the state `ready` wants:
   * all, none, or the planned ones, as `choice` (default: the feed's option) says. Undefined if nothing is sent.
   */
  #sendMentions(choice: MentionChoice | undefined, fileUrl: string, item: FeedItem | undefined, previous: FeedItem | undefined, ready: (item?: FeedItem) => boolean): Promise<MentionReport[]> | undefined {
    choice ??= !!this.#mentions
    const relevant = (i?: FeedItem) => !!i && (itemHandles(i).length > 0 || (isObject(i._source) && typeof i._source.inReplyTo == 'string'))
    if (Array.isArray(choice) ? !choice.length : !choice || !(relevant(item) || relevant(previous))) return
    const mentions = this.#mentionSender
    const id = (item ?? previous)!.id
    const source = `${fileUrl}#${encodeURIComponent(id)}`
    return (async () => {
      await mentions.waitForItem(fileUrl, id, ready)
      return Array.isArray(choice) ? mentions.sendPlanned(source, choice) : mentions.notifyAll({ source, item, previous, me: this.#session.me })
    })().catch(() => [])
  }

  // Reading

  /**
   * Reads a feed file or archive from `storage_base`.
   * @returns undefined if it doesn't exist.
   * @throws {PupsError} `invalid_feed` if it is not a JSON Feed.
   */
  async #read(path: string, signal?: AbortSignal): Promise<Loaded | undefined> {
    const file = await this.#session.get(path, { signal })
    if (!file) return
    if (!file.etag)
      throw new PupsError('server_error', `The server sends no ETag for ${path}, so it can't be changed safely. It must expose the ETag header to browsers (RFC-6, CORS).`)
    let doc: unknown
    try {
      doc = await file.json()
    } catch {
      // Not JSON: handled below.
    }
    if (!isFeedDocument(doc)) throw new PupsError('invalid_feed', `${path} is not a JSON Feed.`)
    return { path, doc, etag: file.etag }
  }

  /** Reads a file that must exist and carry the `_pups` marker. */
  async #readControlled(path: string, signal?: AbortSignal): Promise<Loaded> {
    const loaded = await this.#read(path, signal)
    if (!loaded)
      throw new PupsError('not_found', path == this.path ? `There is no feed at ${path} yet. Set it up with create().` : `${path} doesn't exist.`)
    if (!isControlled(loaded.doc)) throw notControlled(path)
    return loaded
  }

  /**
   * The files that hold all items: the archives from `_pups.archive_url` along `next_url`, as far as they are files
   * on this server. A feed without archives yet (handed over, not posted to) holds its items in the feed file and
   * the pages its `next_url` names.
   */
  async *#chain(main: Loaded, signal?: AbortSignal): AsyncGenerator<Loaded> {
    const visited = new Set<string>([main.path])
    const archive = main.doc._pups?.archive_url
    let file: Loaded | undefined = main
    let next = archive && this.#archiveNumber(archive) !== undefined ? archive : undefined
    if (next) file = undefined
    else yield main
    for (;;) {
      if (file) next = file.doc.next_url
      const path = next && pathFromPublicUrl(this.#session.server, next)
      if (!path || visited.has(path)) return
      visited.add(path)
      try {
        file = await this.#read(path, signal)
      } catch (e) {
        if (!isPupsError(e, 'invalid_feed', 'invalid_path')) throw e
        return
      }
      if (!file) return
      yield file
    }
  }

  async #find(main: Loaded, id: string, signal?: AbortSignal): Promise<Found | undefined> {
    for await (const file of this.#chain(main, signal)) {
      const index = file.doc.items.findIndex(item => item.id == id)
      if (index >= 0) return { main, file, index }
    }
    return
  }

  async #findWritable(id: string, signal?: AbortSignal): Promise<Found> {
    const main = await this.#readControlled(this.path, signal)
    const found = await this.#find(main, id, signal)
    if (!found) throw new PupsError('not_found', `There is no post with the id "${id}" in ${this.path} or its archives.`)
    if (!isControlled(found.file.doc)) throw notControlled(found.file.path)
    return found
  }

  // Writing

  /** Runs `operation` again when another client changed a file in between, up to `maxAttempts` times. */
  async #transaction<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++)
      try {
        return await operation()
      } catch (e) {
        if (!isPupsError(e, 'precondition_failed') || attempt >= this.#maxAttempts) throw e
      }
  }

  /**
   * Writes the feed file. Sets the fixed fields, so that a feed the owner handed over gets them on its first write,
   * and upgrades JSON Feed 1.0 (RFC-7 "Handing over an existing feed"). The optional `next_url` of a feed with
   * archives is kept equal to `archive_url` (RFC-7 "Reading").
   */
  async #writeMain(doc: FeedDocument, etag: string, signal?: AbortSignal): Promise<FeedDocument> {
    const { author, ...rest } = doc
    const fixed: FeedDocument = {
      ...rest,
      version: JSON_FEED_VERSION,
      home_page_url: this.#session.me,
      feed_url: this.url,
      user_comment: mainComment,
    }
    if (author !== undefined && fixed.authors === undefined) fixed.authors = [author as FeedAuthor]
    if (fixed.next_url !== undefined && this.#archiveNumber(fixed._pups?.archive_url) !== undefined) fixed.next_url = fixed._pups!.archive_url
    await this.#session.replace(this.path, serialize(fixed), etag, { contentType: FEED_CONTENT_TYPE, signal })
    return fixed
  }

  /** Writes an archive with `items`, and with the counter `next_index` if given. */
  async #writeArchive(archive: Loaded, items: FeedItem[], signal?: AbortSignal, nextIndex?: number) {
    const doc = nextIndex === undefined ? { ...archive.doc, items } : { ...archive.doc, items, _pups: { ...archive.doc._pups, next_index: nextIndex } }
    await this.#session.replace(archive.path, serialize(doc), archive.etag, { contentType: FEED_CONTENT_TYPE, signal })
  }

  /**
   * The items of the feed file: the newest archive items first (which also repairs items an interrupted post wrote
   * only into the archive), then the other items of the feed file, at most `maxItems`, fewer if `maxBytes` is set
   * and exceeded, but at least 10.
   */
  #newestItems(recent: FeedItem[], current: FeedItem[], doc: FeedDocument): FeedItem[] {
    const ids = new Set(recent.map(item => item.id))
    const items = [...recent, ...current.filter(item => !ids.has(item.id))].slice(0, this.#maxItems)
    if (this.#maxBytes)
      while (items.length > minFeedItems && byteLength(serialize({ ...doc, items })) > this.#maxBytes) items.pop()
    return items
  }

  // Archives

  #archivePath(n: number) {
    return `${this.directory}feed.${String(n).padStart(6, '0')}.json`
  }

  #archiveUrl(n: number) {
    return this.#session.publicUrl(this.#archivePath(n))
  }

  /** The number of the archive at `url`, or undefined if `url` is not an archive file of this feed. */
  #archiveNumber(url: string | undefined): number | undefined {
    const path = url && pathFromPublicUrl(this.#session.server, url)
    if (!path?.startsWith(this.directory)) return
    const match = /^feed\.(\d{6})\.json$/.exec(path.slice(this.directory.length))
    return match ? Number(match[1]) : undefined
  }

  /**
   * A new archive with the feed fields of the feed file (RFC-7 "Archives"), except `_submissions`: whether a feed
   * accepts comments is said by its feed file alone.
   */
  #newArchive(n: number, main: FeedDocument, items: FeedItem[], nextUrl: string | undefined, nextIndex?: number): FeedDocument {
    const { items: _items, next_url: _next, user_comment: _comment, hubs: _hubs, author: _author, _pups, _submissions: _s, ...fields } = main
    const { archive_url: _archive, next_index: _counter, ...marker } = _pups ?? {}
    const podcast = fields._podcast
    if (isObject(podcast) && 'liveItems' in podcast) {
      const { liveItems: _live, ...rest } = podcast
      fields._podcast = rest
    }
    return {
      ...fields,
      version: JSON_FEED_VERSION,
      home_page_url: this.#session.me,
      feed_url: this.#archiveUrl(n),
      user_comment: archiveComment(this.url),
      ...nextUrl ? { next_url: nextUrl } : {},
      items,
      _pups: { about: PUPS_FEED_SPEC, ...marker, pupsControlled: true, updates_url: this.url, ...nextIndex === undefined ? {} : { next_index: nextIndex } },
    }
  }

  async #createArchive(n: number, main: FeedDocument, items: FeedItem[], nextUrl: string | undefined, signal?: AbortSignal, nextIndex?: number) {
    await this.#session.create(this.#archivePath(n), serialize(this.#newArchive(n, main, items, nextUrl, nextIndex)), { contentType: FEED_CONTENT_TYPE, signal })
  }

  /**
   * Reads an archive for writing.
   * @returns undefined if it doesn't exist, 'foreign' if it exists but is no PUPS archive.
   */
  async #readArchive(path: string, signal?: AbortSignal): Promise<Loaded | 'foreign' | undefined> {
    try {
      const loaded = await this.#read(path, signal)
      return loaded && !isControlled(loaded.doc) ? 'foreign' : loaded
    } catch (e) {
      if (isPupsError(e, 'invalid_feed')) return 'foreign'
      throw e
    }
  }

  /**
   * Puts the items of a feed without archives into new archives of `archiveSize`, oldest first (RFC-7 "Starting the
   * archives"). The items get indexes first, and the newest archive the counter. The oldest archive continues the
   * feed's `next_url` chain.
   * @returns the URL of the newest archive and the feed's items with their indexes, or undefined if the feed has no
   *   items.
   */
  async #startArchives(main: Loaded, signal?: AbortSignal): Promise<{ url: string; items: FeedItem[] } | undefined> {
    const indexed = indexItems(main.doc.items, nextFree(main.doc.items, counterOf(main.doc)))
    const oldestFirst = [...indexed.items].reverse()
    const count = Math.ceil(oldestFirst.length / this.#archiveSize)
    let url: string | undefined
    for (let n = 0; n < count; n++) {
      const items = oldestFirst.slice(n * this.#archiveSize, (n + 1) * this.#archiveSize).reverse()
      const nextUrl = n ? this.#archiveUrl(n - 1) : main.doc.next_url
      const nextIndex = n == count - 1 ? indexed.next : undefined
      try {
        await this.#createArchive(n, main.doc, items, nextUrl, signal, nextIndex)
      } catch (e) {
        if (!isPupsError(e, 'precondition_failed')) throw e
        // Left behind by an interrupted start: complete it, as long as it holds only these items.
        const existing = await this.#readArchive(this.#archivePath(n), signal)
        const ids = new Set(items.map(item => item.id))
        if (!existing || existing == 'foreign' || !existing.doc.items.every(item => ids.has(item.id)))
          throw new PupsError('conflict', `${this.#archivePath(n)} exists already, but ${this.path} has no archive_url. Remove the file, or set _pups.archive_url (RFC-7, Starting the archives).`)
        await this.#writeArchive(existing, items, signal, nextIndex)
      }
      url = this.#archiveUrl(n)
    }
    return url ? { url, items: indexed.items } : undefined
  }

  /**
   * Indexes a feed with archives whose newest archive has no counter, or items without an index (RFC-7 "Indexing an
   * existing feed"): gives every archived item without an index one, the oldest first, writes the changed archives
   * from the oldest to the newest, the newest with the counter, and then the feed file's copies.
   */
  async #indexArchives(main: Loaded, signal?: AbortSignal): Promise<void> {
    const files: Loaded[] = []
    for await (const file of this.#chain(main, signal)) {
      // Pages behind the oldest archive of a handed-over feed are never written, and keep their items unindexed.
      if (file == main || !isControlled(file.doc)) break
      files.push(file)
    }
    if (!files.length) return
    let next = nextFree(files.flatMap(file => file.doc.items), ...files.map(file => counterOf(file.doc)))
    const indexes = new Map<string, number>()
    for (const file of [...files].reverse()) {
      const indexed = indexItems(file.doc.items, next)
      next = indexed.next
      for (const item of indexed.items) indexes.set(item.id, itemIndex(item)!)
      const newest = file == files[0]
      if (indexed.changed || (newest && counterOf(file.doc) !== next)) await this.#writeArchive(file, indexed.items, signal, newest ? next : undefined)
    }
    let changed = false
    const items = main.doc.items.map(item => {
      const index = indexes.get(item.id)
      if (index === undefined || itemIndex(item) === index) return item
      changed = true
      return withIndex(item, index)
    })
    if (changed) await this.#writeMain({ ...main.doc, items }, main.etag, signal)
  }

  /**
   * Adds an item to the newest archive, or to a new archive if the newest holds `archiveSize` items (RFC-7
   * "Posting"). Writes only archives; the caller writes the feed file afterwards.
   * The item gets its index from the archive's counter (RFC-7 "Indexes"); a newest archive without a counter is
   * indexed first, and the post then starts again.
   * @returns the archive's URL, the newest items known from the archives, newest first, and the item as stored.
   */
  async #addToArchive(main: Loaded, doc: FeedDocument, item: FeedItem, signal?: AbortSignal, template?: string): Promise<{ url: string; recent: FeedItem[]; item: FeedItem }> {
    const place = (index: number) => this.#withPostUrl(withIndex(item, index), index, template)
    const newest = this.#archiveNumber(doc._pups?.archive_url)
    let previous: FeedItem[] = []
    // The index for the item if it goes into a new archive.
    let next = nextFree(doc.items, newest === undefined ? counterOf(doc) : undefined)
    if (newest !== undefined) {
      const existing = await this.#readArchive(this.#archivePath(newest), signal)
      if (!existing) {
        // The owner deleted it: create it again, linked to the next older archive, with an index above all known ones.
        const before = newest ? await this.#readArchive(this.#archivePath(newest - 1), signal) : undefined
        if (before && before != 'foreign') next = nextFree([...doc.items, ...before.doc.items], counterOf(before.doc))
        const stored = place(next)
        await this.#createArchive(newest, doc, [stored], newest ? this.#archiveUrl(newest - 1) : undefined, signal, next + 1)
        return { url: this.#archiveUrl(newest), recent: [stored], item: stored }
      }
      if (existing != 'foreign') {
        if (counterOf(existing.doc) === undefined) {
          await this.#indexArchives(main, signal)
          throw conflict(`${this.path} was indexed, so it`)
        }
        // Items that a client without indexes added get theirs first (RFC-7 "Items without an index").
        const indexed = indexItems(existing.doc.items, nextFree(existing.doc.items, counterOf(existing.doc)))
        const copy = indexed.items.find(i => i.id == item.id)
        const stored = place(copy ? itemIndex(copy)! : indexed.next)
        const merged = mergeItems(indexed.items, [stored])
        if (merged.length <= this.#archiveSize) {
          await this.#writeArchive(existing, merged, signal, copy ? indexed.next : indexed.next + 1)
          return { url: this.#archiveUrl(newest), recent: merged, item: stored }
        }
        if (indexed.changed) await this.#writeArchive(existing, indexed.items, signal, indexed.next)
        previous = indexed.items
        next = indexed.next
      }
    }
    // The archive before the new one: the newest, or for a feed without archives the end of its old chain.
    const nextUrl = newest === undefined ? doc.next_url : this.#archiveUrl(newest)
    for (let n = newest === undefined ? 0 : newest + 1; n <= maxArchiveNumber; n++) {
      const stored = place(next)
      try {
        await this.#createArchive(n, doc, [stored], nextUrl, signal, next + 1)
        return { url: this.#archiveUrl(n), recent: [stored, ...previous], item: stored }
      } catch (e) {
        if (!isPupsError(e, 'precondition_failed')) throw e
      }
      // The archive exists: left behind by an interrupted client, or created by another client just now.
      const existing = await this.#readArchive(this.#archivePath(n), signal)
      if (existing && existing != 'foreign' && existing.doc.next_url == nextUrl) {
        const indexed = indexItems(existing.doc.items, nextFree(existing.doc.items, counterOf(existing.doc), next))
        const copy = indexed.items.find(i => i.id == item.id)
        const added = place(copy ? itemIndex(copy)! : indexed.next)
        const merged = mergeItems(indexed.items, [added])
        if (merged.length <= this.#archiveSize) {
          await this.#writeArchive(existing, merged, signal, copy ? indexed.next : indexed.next + 1)
          return { url: this.#archiveUrl(n), recent: [...merged, ...previous], item: added }
        }
      }
      const current = await this.#session.get(this.path, { signal })
      if (current?.etag != main.etag) throw conflict(this.path)
    }
    throw new PupsError('conflict', `No free archive number in ${this.directory}.`)
  }

  // Items and media

  /** The site's post URL template from `host-meta.json`, read once; undefined if there is none or it can't be read. */
  #postUrlTemplate(signal?: AbortSignal): Promise<string | undefined> {
    if (!this.#postUrls) return Promise.resolve(undefined)
    this.#template ??= this.#session.hostMeta.get({ signal })
      .then(doc => doc.properties?.[POST_URL_TEMPLATE])
      .then(template => validTemplate(template) ? template : undefined, () => undefined)
    return this.#template
  }

  /** The item with the `url` from the post URL template (RFC-7 "Post URLs"), unless it has one. */
  #withPostUrl(item: FeedItem, index: number, template?: string): FeedItem {
    if (!template || item.url) return item
    const vars: Record<string, string> = { feed: this.path.slice(1, -'.json'.length), index: String(index), id: encodeURIComponent(item.id) }
    return { ...item, url: template.replace(/\{(feed|index|id)\}/g, (_, name: string) => vars[name]!) }
  }

  #newItem(input: PostInput): FeedItem {
    const { id, markdown, date_published, ...fields } = input
    if (id !== undefined && (typeof id != 'string' || !id))
      throw new PupsError('invalid_request', 'A post id must be a non-empty string.')
    const item: FeedItem = {
      id: id ?? randomString(12),
      ...fields,
      date_published: date_published instanceof Date ? date_published.toISOString() : date_published ?? now(),
    }
    if (markdown !== undefined) this.#setMarkdown(item, markdown)
    if (item.content_html === undefined && item.content_text === undefined)
      throw new PupsError('invalid_request', 'A post needs content_html, content_text or markdown (JSON Feed requires content).')
    // The index is given out when the item is added (RFC-7 "Indexes").
    if (isObject(item._pups)) {
      const { index: _index, ...marker } = item._pups
      if (Object.keys(marker).length) item._pups = marker
      else delete item._pups
    }
    return item
  }

  #applyChanges(item: FeedItem, changes: PostChanges): FeedItem {
    for (const [key, value] of Object.entries(changes)) {
      if (key == 'id') throw new PupsError('invalid_request', 'The id of a post can\'t be changed.')
      if (value === undefined) continue
      if (key == 'markdown') {
        if (value === null) {
          const source = isObject(item._source) ? { ...item._source } : undefined
          if (source) {
            delete source.markdown
            item._source = source
          }
        } else this.#setMarkdown(item, value as string)
      } else if (value === null) delete item[key]
      else item[key] = value instanceof Date ? value.toISOString() : value
    }
    if (item.content_html === undefined && item.content_text === undefined)
      throw new PupsError('invalid_request', 'A post needs content_html or content_text (JSON Feed requires content).')
    return item
  }

  /** Stores Markdown in `_source.markdown` (RFC-1), with `content_text` as the fallback JSON Feed requires. */
  #setMarkdown(item: FeedItem, markdown: string) {
    const source = isObject(item._source) ? item._source : {}
    item._source = { about: RFC1_URL, ...source, markdown }
    if (item.content_html === undefined) item.content_text = markdown
  }

  #result(item: FeedItem, fileUrl: string): PostResult {
    const index = itemIndex(item)
    return { id: item.id, ...index === undefined ? {} : { index }, item, url: `${fileUrl}#${encodeURIComponent(item.id)}` }
  }

  /**
   * The URLs of this feed's media files (not icons, not archives) that an item references. For the main feed, only
   * `/feed/images/` and `/feed/media/`, so that files of named feeds are never taken for its own.
   */
  #mediaUrls(item: FeedItem): string[] {
    const base = this.#session.publicUrl(this.directory)
    const bases = this.name === undefined ? mainMediaFolders.map(folder => `${base}${folder}/`) : [base]
    const icons = `${base}images/icons/`
    const urls = new Set<string>()
    for (const text of strings(item))
      for (const [url] of text.matchAll(/https?:\/\/[^\s"'<>()]+/g))
        if (bases.some(b => url.startsWith(b)) && !url.startsWith(icons) && this.#archiveNumber(url) === undefined) urls.add(url)
    return [...urls]
  }

  #mediaType(media: MediaInput): { type: string; extension: string; body: Body } {
    const blob = typeof Blob != 'undefined' && media instanceof Blob ? media : undefined
    const given = blob ? undefined : media as { body: Body; type?: string; extension?: string }
    const nameExtension = (blob as File | undefined)?.name?.match(/\.([a-z0-9]+)$/i)?.[1]
    const type = blob?.type || given?.type
    const extension = (given?.extension ?? nameExtension ?? (type ? extensionForType(type) : undefined))?.toLowerCase().replace(/^\./, '')
    const fileType = extension ? fileTypes[extension] : undefined
    if (!extension || !fileType)
      throw new PupsError('unsupported_type', `Can't tell the file type of the upload${extension ? ` (".${extension}" is not allowed)` : ''}. Pass a Blob with a type, or { body, type } or { body, extension } (RFC-6, File types).`)
    return { type: fileType.served, extension, body: blob ?? given!.body }
  }

  async #upload(media: MediaInput, prefix: string, signal?: AbortSignal): Promise<MediaResult> {
    const { type, extension, body } = this.#mediaType(media)
    const path = `${this.directory}${prefix}${randomString(9)}.${extension}`
    const result = await this.#session.create(path, body, { signal })
    const size = typeof body == 'string' ? byteLength(body) : body instanceof Blob ? body.size : (body as ArrayBuffer | ArrayBufferView).byteLength
    // Feed directories are public, so the result always has a URL.
    return { path, url: result.url!, type, size }
  }

  async #setImage(field: 'icon' | 'favicon', media: MediaInput | null, signal?: AbortSignal): Promise<FeedDocument> {
    const uploaded = media ? await this.#upload(media, `images/icons/${field}-`, signal) : undefined
    let old: unknown
    let doc: FeedDocument
    try {
      doc = await this.#transaction(async () => {
        const main = await this.#readControlled(this.path, signal)
        old = main.doc[field]
        const changed = { ...main.doc }
        if (uploaded) changed[field] = uploaded.url
        else delete changed[field]
        return this.#writeMain(changed, main.etag, signal)
      })
    } catch (e) {
      if (uploaded) await this.#deleteQuietly(uploaded.path)
      throw e
    }
    const oldPath = typeof old == 'string' && old != uploaded?.url ? pathFromPublicUrl(this.#session.server, old) : undefined
    if (oldPath?.startsWith(`${this.directory}images/icons/`)) await this.#deleteQuietly(oldPath, signal)
    return doc
  }

  /** Deletes a file, ignoring a missing one. @returns whether it was deleted. */
  async #deleteQuietly(path: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.#session.delete(path, { signal })
      return true
    } catch (e) {
      if (isPupsError(e, 'not_found')) return false
      throw e
    }
  }

  #checkSettings(settings: Record<string, unknown>) {
    for (const key of Object.keys(settings))
      if (reservedFields.has(key))
        throw new PupsError('invalid_request', key == 'icon' || key == 'favicon'
          ? `Set ${key} with ${key == 'icon' ? 'setIcon' : 'setFavicon'}(), which stores it in images/icons/ (RFC-7, Icons).`
          : `"${key}" is fixed or managed by RFC-7 and can't be set.`)
      else if (!['title', 'description', 'authors', 'language', 'expired'].includes(key) && !key.startsWith('_'))
        throw new PupsError('invalid_request', `"${key}" is not a feed field the owner can set. Use title, description, authors, language, expired or an extension starting with "_".`)
  }

  #checkWritable() {
    if (!this.writable)
      throw new PupsError('insufficient_scope', `Writing ${this.path} needs the scopes ${this.scopes.join(' ')} (RFC-7, Server requirements).`)
  }
}

/** The feeds registered in the owner's `host-meta.json` (RFC-7 "Registering feeds"). */
export async function listFeeds(session: PupsSession, options: Signal & FeedOptions = {}): Promise<FeedLink[]> {
  const document = await session.hostMeta.get(options)
  const links = (document.links ?? []).filter(link => link.rel == FEED_REL && typeof link.href == 'string')
  return links.map(link => {
    const url = link.href!
    const path = pathFromPublicUrl(session.server, url)
    const name = path == '/feed.json' ? null : /^\/feed\/([^/]+)\.json$/.exec(path ?? '')?.[1]
    let feed: PupsFeed | undefined
    if (name !== undefined)
      try {
        feed = new PupsFeed(session, name ?? undefined, options)
      } catch {
        // Not a valid feed name, e.g. an archive or a link the owner added.
      }
    return { url, ...typeof link.type == 'string' ? { type: link.type } : {}, ...feed ? { feed } : {} }
  })
}
