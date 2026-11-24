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
 * `https://tim.example/p/{feed}/post/{index}` (RFC-6 "Post URLs"). The server fills it into new posts.
 */
export const POST_URL_TEMPLATE = 'https://bigwide.net/ns/post-url-template'

/** The `about` of the `_pups` object: RFC-7. Not its final location; readers must not rely on it. */
export const PUPS_FEED_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md'

/** The `about` of the `_archive` object: RFC-13 (JSON Feed Archives). Not its final location either. */
export const ARCHIVE_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md'

const RFC1_URL = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
const RFC4_URL = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md'
const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1'
const FEED_CONTENT_TYPE = 'application/feed+json'

/** Feed names (RFC-7 "Named feeds"): 1 to 40 lowercase letters, digits and `-`, not starting or ending with `-`. */
const feedNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** The main feed's media directories in `/feed/`. */
const mainMediaFolders = ['images', 'media']

/** Names in `/feed/` that belong to the main feed, its media and comment feeds, and therefore can't be feed names. */
const reservedNames = [...mainMediaFolders, 'comments']

/** Top-level fields that are fixed or managed by RFC-7, and can't be set through `create()` or `updateSettings()`. */
const reservedFields = new Set(['version', 'home_page_url', 'feed_url', 'user_comment', 'next_url', 'items', 'hubs', '_pups', '_archive', 'icon', 'favicon'])

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
  /** The item's `_archive` object, with its index (RFC-13 "Indexes"). */
  _archive?: ItemArchive
  [field: string]: unknown
}

/** The `_archive` object of an item (RFC-13). */
export interface ItemArchive {
  /** The item's index: 0 for a feed's first item, then counting up; never changed, never used again (RFC-13 "Indexes"). */
  index?: number
  [field: string]: unknown
}

/** The `_pups` object of a feed file or archive: the marker of RFC-7. */
export interface PupsMarker {
  about?: string
  pupsControlled?: boolean
  [field: string]: unknown
}

/** The `_archive` object of a feed file or archive (RFC-13). The server writes it. */
export interface ArchiveFields {
  about?: string
  /** In the feed file: the public URL of the newest archive. */
  archive_url?: string
  /** In the feed file: the URL of every archive, with `{number}` for its six-digit number. */
  archive_template?: string
  /** In the feed file: the most items an archive holds. */
  archive_size?: number
  /** In an archive: the public URL of the feed file, which readers poll. */
  updates_url?: string
  /** In an archive: its number, from 0 for the oldest. */
  number?: number
  /** In the newest archive: the index the next new item gets (RFC-13 "Indexes"). */
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
  _archive?: ArchiveFields
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
 * server's receiver enforces `title`, `minLength`, `maxLength`, `requireSocialSpec`, `allowEdit`, `allowDelete`,
 * `commentLimit` and `maxDepth` (at most 10).
 */
export interface CommentPolicy {
  title?: 'required' | 'allowed' | 'none'
  minLength?: number
  maxLength?: number
  requireSocialSpec?: boolean
  allowEdit?: boolean
  allowDelete?: boolean
  /** The comments a post may have, on all levels (RFC-4 default 1000). */
  commentLimit?: number
  /** How deep replies are nested: 1 allows comments on posts only, 2 also replies to them (RFC-4 default 5). */
  maxDepth?: number
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
  /** 192 × 192 pixels, stored in `images/icons/` in the feed directory. */
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
  /** The item's index (RFC-13 "Indexes"). */
  index?: number
  /** The item as stored. */
  item: FeedItem
  /**
   * The item's address: the URL of its archive plus `#<id>` (RFC-13 "Items"). Items never leave their archive, so it
   * never changes; use it e.g. as the `source` of an RFC-4 webmention. The post's page, if it has one, is `item.url`.
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
  /** A feed kept by the PUPS server, ready to write. */
  | { status: 'pups'; feed: FeedDocument; etag: string }
  /** A JSON Feed without `_pups.pupsControlled`: maintained by other means, and never written (RFC-7). */
  | { status: 'foreign'; feed: FeedDocument }
  /** The file exists but is not a JSON Feed. */
  | { status: 'invalid' }

export interface FeedOptions {
  /** How often a change of the feed's settings is repeated when someone changed the feed in between. Default 8. */
  maxAttempts?: number
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

/** The server's answer to a POST of an item (RFC-7 "Posting items"). */
interface Posted {
  item: FeedItem
  address: string
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
  if (reservedNames.includes(name))
    throw new PupsError('invalid_request', `"${name}" can't be a feed name: /feed/${name}/ and its files belong to the main feed (RFC-7, Named feeds).`)
  return { path: `/feed/${name}.json`, directory: `/feed/${name}/` }
}

const isFeedDocument = (value: unknown): value is FeedDocument =>
  isObject(value) && typeof value.version == 'string' && value.version.startsWith('https://jsonfeed.org/version/1')
  && Array.isArray(value.items) && value.items.every(i => isObject(i) && typeof i.id == 'string')

const isControlled = (doc: FeedDocument) => doc._pups?.pupsControlled === true

const notControlled = (path: string) =>
  new PupsError('not_pups_controlled', `${path} is not kept by PUPS: it has no "_pups": { "pupsControlled": true }. It is never written; the owner can hand it over by adding that marker (RFC-7, The _pups object).`)

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const clone = <T>(value: T): T => structuredClone(value)

const serialize = (doc: FeedDocument) => JSON.stringify(doc, null, 2)

const byteLength = (text: string) => new TextEncoder().encode(text).length

/** The index of an item (RFC-13 "Indexes"), or undefined if it has none. */
export function itemIndex(item: FeedItem): number | undefined {
  const index = isObject(item._archive) ? item._archive.index : undefined
  return typeof index == 'number' && Number.isSafeInteger(index) && index >= 0 ? index : undefined
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

/** The answer to a POST of an item, checked. */
function posted(body: unknown, path: string): Posted {
  if (!isObject(body) || !isObject(body.item) || typeof body.item.id != 'string' || typeof body.address != 'string')
    throw new PupsError('server_error', `The server's answer to the POST to ${path} has no item and address (RFC-7, Posting items).`)
  return { item: body.item as FeedItem, address: body.address }
}

/** The file part of an item's address. */
const fileOf = (address: string) => address.split('#')[0]!

/**
 * A feed on the owner's domain, kept by the PUPS server according to RFC-7: the main feed `/feed.json`, or a named
 * feed `/feed/<name>.json`, each with its feed directory for archives, icons and media: `/feed/`, or `/feed/<name>/`.
 * The main feed keeps its media in `/feed/images/` and `/feed/media/`, since the rest of `/feed/` belongs to the
 * named feeds.
 *
 * Get one from `session.feed()` or `session.feed('photos')`. The session needs the feed's scopes, see
 * {@link feedScopes}. Posts are sent to the server one at a time, which gives them their index and puts them into
 * the archives (RFC-13); changes of the feed's settings are read-modify-write cycles with ETags, repeated when
 * another app wrote in between.
 */
export class PupsFeed {
  /** The name of a named feed; undefined for the main feed. */
  readonly name?: string
  /** The feed file, e.g. `/feed.json` or `/feed/photos.json`. */
  readonly path: string
  /** The feed directory, e.g. `/feed/` or `/feed/photos/`. */
  readonly directory: string
  readonly #session: PupsSession
  readonly #maxAttempts: number
  readonly #mentions?: Mentions

  /** @internal Use `session.feed()`. */
  constructor(session: PupsSession, name?: string, options: FeedOptions = {}) {
    const { path, directory } = feedPaths(name)
    this.name = name
    this.path = path
    this.directory = directory
    this.#session = session
    this.#maxAttempts = options.maxAttempts ?? 8
    this.#mentions = options.mentions === true ? session.mentions : options.mentions || undefined
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
    return this.#session.canWrite(this.path) && this.#session.canWrite(`${this.directory}images/x`)
  }

  /** Reads the feed file and tells whether it exists, and whether the server keeps it. */
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
   * Sets up a new feed (RFC-7 "Setting up a feed"): uploads the icons, writes the feed file with the `_pups` marker,
   * and registers the feed in `host-meta.json` (unless `register` is false). The server sets the fixed fields.
   * @returns `registered`: false if the feed couldn't be registered; call `register()` again later, or tell the owner
   *   to add the link to `host-meta.json` by hand.
   * @throws {PupsError} `precondition_failed` if the feed file exists already; `insufficient_scope`; `unsupported` if
   *   the server doesn't keep feeds.
   */
  async create(setup: FeedSetup, options: Signal & { register?: boolean } = {}): Promise<{ url: string; registered: boolean }> {
    const { icon, favicon, title, ...settings } = setup
    if (typeof title != 'string' || !title.trim()) throw new PupsError('invalid_request', 'A feed needs a title.')
    this.#checkSettings(settings)
    this.#checkWritable()
    this.#checkKept()
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
        ...description === undefined ? {} : { description },
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
    return this.#change(doc => {
      for (const [key, value] of Object.entries(changes))
        if (value === null) delete doc[key]
        else if (value !== undefined) doc[key] = value
    }, options.signal)
  }

  /**
   * Uploads a new icon (512 × 512) to `/feed/images/icons/` (`/feed/<name>/images/icons/` for a named feed) and
   * deletes the old one, or removes it with `null`.
   */
  setIcon(media: MediaInput | null, options: Signal = {}): Promise<FeedDocument> {
    return this.#setImage('icon', media, options.signal)
  }

  /** Uploads a new favicon (192 × 192) to the icons directory, like `setIcon()`, or removes it with `null`. */
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
   * (RFC-6 "Built-in receiver"). The owner approves them there, and the server publishes them in a comment feed per
   * post, which the post's `_source.comments` names (RFC-7 "Publishing comments"): in full, or with
   * `republish: 'summary'` as an abstract of 150 characters that links to the comment (which then needs a `url`). With
   * `republish: 'no'`, the owner only reads them. Writes RFC-4 `_submissions` into the feed file, with
   * `comment_endpoint` as `url`, the comments policy (RFC-4's defaults for `title`, `minLength`, `maxLength` and
   * `maxDepth`, 5 levels of replies, overridden by `policy`) and `republish`, by default `full`. Replies to comments
   * go into comment feeds of their own, which the comment's `_source.comments` names. Replaces the `_submissions` of another
   * service; check `comments()` first and ask the owner. Single posts are closed with
   * `_commenting: { allowComments: false }` (RFC-4).
   * @throws {PupsError} `unsupported` if the server has no `comment_endpoint`.
   */
  async enableComments(settings: { policy?: CommentPolicy; tos?: string; republish?: 'full' | 'summary' | 'no' } = {}, options: Signal = {}): Promise<FeedDocument> {
    const url = this.#session.server.commentEndpoint
    if (!url) throw new PupsError('unsupported', 'This PUPS server doesn\'t receive comments: its configuration has no comment_endpoint (RFC-6, Built-in receiver).')
    return this.#setSubmissions({
      about: RFC4_URL,
      url,
      ...settings.tos ? { tos: settings.tos } : {},
      policies: { comments: { title: 'none', minLength: 2, maxLength: 2000, maxDepth: 5, ...settings.policy } },
      republish: settings.republish ?? 'full',
    }, options.signal)
  }

  /** Closes the feed for comments: removes `_submissions` from the feed file, whichever service it names. */
  disableComments(options: Signal = {}): Promise<FeedDocument> {
    return this.#setSubmissions(undefined, options.signal)
  }

  #setSubmissions(submissions: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<FeedDocument> {
    return this.#change(doc => {
      if (submissions) doc._submissions = submissions
      else delete doc._submissions
    }, signal)
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
    if (folder.split('/')[0] == 'comments')
      throw new PupsError('invalid_request', `${this.directory}comments/ is reserved for the comment feeds that the server writes (RFC-7, Publishing comments).`)
    if (this.name === undefined && !mainMediaFolders.includes(folder.split('/')[0]!))
      throw new PupsError('invalid_request', `The main feed's media go into /feed/images/ or /feed/media/; the rest of /feed/ belongs to named feeds (RFC-7, Items).`)
    return this.#upload(media, `${folder}/${new Date().getUTCFullYear()}/`, options.signal)
  }

  /**
   * Adds a post (RFC-7 "Posting items"): sends it to the server, which gives it its index, puts it into the newest
   * archive and at the top of the feed file, and, if the site declares a post URL template, gives it the `url` of
   * its page. Upload media with `uploadMedia()` before posting.
   * With the option `mentions`, the domains the post names and the author of the item it answers are notified
   * (RFC-11) once the post is visible; see `PostResult.mentions`.
   * @returns the post as stored, with `url`: its address, which never changes. The post's page, if it has one, is
   *   `item.url`.
   * @throws {PupsError} `not_found` if the feed doesn't exist; `not_pups_controlled`; `unsupported` if the server
   *   doesn't keep feeds.
   */
  async addPost(input: PostInput, options: WithMentions = {}): Promise<PostResult> {
    const { item, address } = await this.#post(this.#newItem(input), options.signal)
    return this.#withMentions(options.mentions, this.#result(item, address), fileOf(address), item, undefined, found => !!found)
  }

  /**
   * Finds a post by id in the archives.
   * @returns undefined if there is no such post.
   */
  async getPost(id: string, options: Signal = {}): Promise<PostResult | undefined> {
    const main = await this.#read(this.path, options.signal)
    if (!main) return
    for await (const file of this.#chain(main, options.signal)) {
      const item = file.doc.items.find(i => i.id == id)
      if (item) return this.#result(item, `${this.#session.publicUrl(file.path)}#${encodeURIComponent(id)}`)
    }
    return
  }

  /**
   * All posts, newest first: the archives from `_archive.archive_url` along `next_url` (for a feed without archives,
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
   * Edits a post (RFC-7 "Posting items"): reads it from its archive, applies `changes`, and sends it to the server,
   * which replaces it in its archive and in the feed file and sets `date_modified`. `changes` is either an object (a
   * value sets a field, `null` removes it), or a function that gets a copy of the item and returns the new item, or
   * `undefined` to leave it unchanged. The post keeps its id and index.
   *
   * Apps should edit posts only when the owner asks them to, whichever app created them. With the option
   * `mentions`, everyone the old or the new version mentions is notified.
   * @throws {PupsError} `not_found`
   */
  async editPost(id: string, changes: PostChanges | ((item: FeedItem) => FeedItem | undefined | Promise<FeedItem | undefined>), options: WithMentions = {}): Promise<PostResult> {
    const signal = options.signal
    const current = await this.getPost(id, options)
    if (!current) throw new PupsError('not_found', `There is no post with the id "${id}" in ${this.path} or its archives.`)
    const old = current.item
    const changed = typeof changes == 'function' ? await changes(clone(old)) : this.#applyChanges(clone(old), changes)
    if (!changed) return current
    // The index names the post for the server (RFC-7 "Posting items"), and never changes.
    const { _pups: _marker, ...rest } = changed
    const { item, address } = await this.#post({ ...rest, id, _archive: { ...isObject(rest._archive) ? rest._archive : {}, ...old._archive } }, signal)
    return this.#withMentions(options.mentions, this.#result(item, address), fileOf(address), item, old, found => found?.date_modified == item.date_modified)
  }

  /**
   * Deletes a post (RFC-7 "Posting items"): the server removes it from its archive and from the feed file, which it
   * fills up again from the archives. With `deleteMedia`, it also deletes the files in the feed directory that the
   * post references and no other post does; this reads all archives.
   * @returns the deleted item, and the public URLs of the deleted media files.
   * @throws {PupsError} `not_found`
   */
  async deletePost(id: string, options: WithMentions & { deleteMedia?: boolean } = {}): Promise<{ item: FeedItem; deletedMedia: string[]; mentions?: Promise<MentionReport[]> }> {
    const signal = options.signal
    const { item, address } = await this.#post({ id, _pups: { delete: true } }, signal)
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
    const mentions = this.#sendMentions(options.mentions, fileOf(address), undefined, item, found => !found)
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
   * (RFC-4 "Submitting"): `source` is the post's address, `target` its `_source.inReplyTo`. Call it after `addPost()`
   * or `editPost()`, also to submit an edit or a delete again. Show the target's terms of service and what its
   * `republish` means before the first submission.
   * @throws {PupsError} `not_found`; `invalid_request` if the post answers nothing; `unsupported` if the target
   *   feed takes no submissions.
   * @deprecated Comments and group posts don't belong in a feed for readers (RFC-7 "Comment feeds"). Use
   *   `session.comments.post()`, which keeps them in comment feeds in the app's directory.
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

  /**
   * The files that hold all items: the archives from `_archive.archive_url` along `next_url`, as far as they are files
   * on this server. A feed without archives (handed over, not written yet) holds its items in the feed file and the
   * pages its `next_url` names.
   */
  async *#chain(main: Loaded, signal?: AbortSignal): AsyncGenerator<Loaded> {
    const visited = new Set<string>([main.path])
    const archive = main.doc._archive?.archive_url
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

  // Writing

  /** Sends an item to the server (RFC-7 "Posting items"). */
  async #post(item: Record<string, unknown>, signal?: AbortSignal): Promise<Posted> {
    this.#checkKept()
    try {
      return posted((await this.#session.post(this.path, item, { signal })).body, this.path)
    } catch (e) {
      if (isPupsError(e, 'not_pups_controlled')) throw notControlled(this.path)
      if (isPupsError(e, 'not_found') && !await this.#session.get(this.path, { signal }))
        throw new PupsError('not_found', `There is no feed at ${this.path} yet. Set it up with create().`, { cause: e })
      throw e
    }
  }

  /**
   * Changes the feed file's fields with `change` and writes it with `If-Match`; reads it again and repeats when
   * someone else wrote in between, up to `maxAttempts` times. The server keeps the items and the archive fields.
   * @returns the feed as written.
   */
  async #change(change: (doc: FeedDocument) => void, signal?: AbortSignal): Promise<FeedDocument> {
    for (let attempt = 1; ; attempt++) {
      const main = await this.#read(this.path, signal)
      if (!main) throw new PupsError('not_found', `There is no feed at ${this.path} yet. Set it up with create().`)
      if (!isControlled(main.doc)) throw notControlled(this.path)
      const doc = clone(main.doc)
      change(doc)
      try {
        await this.#session.replace(this.path, serialize(doc), main.etag, { contentType: FEED_CONTENT_TYPE, signal })
        return doc
      } catch (e) {
        if (!isPupsError(e, 'precondition_failed') || attempt >= this.#maxAttempts) throw e
      }
    }
  }

  /** The number of the archive at `url`, or undefined if `url` is not an archive file of this feed. */
  #archiveNumber(url: string | undefined): number | undefined {
    const path = url && pathFromPublicUrl(this.#session.server, url)
    if (!path?.startsWith(this.directory)) return
    const match = /^feed\.(\d{6,})\.json$/.exec(path.slice(this.directory.length))
    return match ? Number(match[1]) : undefined
  }

  // Items and media

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
    // An item with an index names an existing item; the server gives new items theirs (RFC-7 "Posting items").
    delete item._pups
    if (isObject(item._archive)) {
      const { index: _index, ...rest } = item._archive
      if (Object.keys(rest).length) item._archive = rest
      else delete item._archive
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

  #result(item: FeedItem, address: string): PostResult {
    const index = itemIndex(item)
    return { id: item.id, ...index === undefined ? {} : { index }, item, url: address }
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
      doc = await this.#change(doc => {
        old = doc[field]
        if (uploaded) doc[field] = uploaded.url
        else delete doc[field]
      }, signal)
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

  #checkKept() {
    if (!this.#session.server.keptFeeds)
      throw new PupsError('unsupported', `This PUPS server doesn't keep feeds: its configuration has no "kept_feeds": true (RFC-7, Server requirements).`)
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
