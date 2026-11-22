import { isPupsError, PupsError } from './errors.js'
import type { FeedAttachment, FeedAuthor, FeedDocument, FeedItem } from './feed.js'
import type { Submission } from './mentions.js'
import { pathFromPublicUrl } from './paths.js'
import type { PupsSession } from './session.js'
import { isObject, randomString } from './util.js'

const RFC1_URL = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
const JSON_FEED = 'https://jsonfeed.org/version/1.1'

type Signal = { signal?: AbortSignal }

/** A comment, or a post to a discussion group: what an RFC-4 submission publishes. */
export interface CommentInput {
  /** The answered item, as feed URL plus `#<id>`; for a new post in a group, the group feed's URL. */
  target: string
  title?: string
  content_html?: string
  content_text?: string
  /** The text as Markdown, stored in `_source.markdown` (RFC-1), and as `content_text` if neither content is given. */
  markdown?: string
  url?: string
  authors?: FeedAuthor[]
  language?: string
  attachments?: FeedAttachment[]
  [extension: `_${string}`]: unknown
}

/** Changes to a comment: a value sets the field, `null` removes it, `undefined` leaves it unchanged. */
export type CommentChanges = { [K in Exclude<keyof CommentInput, 'target'>]?: CommentInput[K] | null }

export interface CommentResult {
  /** The comment's `source`: the public URL of its comment feed plus `#<id>`. It never changes. */
  source: string
  /** The comment feed, below `/appdata/<client-host>/comments/`. */
  path: string
  /** The item as stored; for a deleted comment, as it was. */
  item: FeedItem
  /** The RFC-4 submission; missing with `submit: false`. */
  submission?: Submission
}

type SubmitOption = Signal & {
  /** Submit to the target after writing (default `true`). Show the target's terms of service before the first one. */
  submit?: boolean
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The comment feed for a comment on `target` published at `date`, relative to the comments directory, in the layout
 * RFC-7 recommends ("Comment feeds"): `<hash3>/<hash>.json`, where `<hash>` is the first 16 hex characters of the
 * SHA-256 of `<target host> <yyyymmddhh>`, with the hour in UTC, and `<hash3>` its last three characters.
 * @throws {PupsError} `invalid_request` if `target` is not an http(s) URL or `date` is invalid.
 */
export async function commentFeedPath(target: string, date: Date | string): Promise<string> {
  let host: string
  try {
    const url = new URL(target)
    if (url.protocol != 'https:' && url.protocol != 'http:') throw new Error()
    host = url.hostname
  } catch {
    throw new PupsError('invalid_request', `"${target}" is not an http(s) URL, so it can't be the target of a comment (RFC-4).`)
  }
  const time = new Date(date)
  if (isNaN(+time)) throw new PupsError('invalid_request', `"${date}" is not a valid date.`)
  const hour = time.toISOString().slice(0, 13).replace(/[-T]/g, '')
  const hash = (await sha256Hex(`${host} ${hour}`)).slice(0, 16)
  return `${hash.slice(-3)}/${hash}.json`
}

const isFeed = (doc: unknown): doc is FeedDocument =>
  isObject(doc) && typeof doc.version == 'string' && doc.version.startsWith('https://jsonfeed.org/version/') && Array.isArray(doc.items)

const inReplyTo = (item: FeedItem) => isObject(item._source) && typeof item._source.inReplyTo == 'string' ? item._source.inReplyTo : undefined

/** Stores Markdown in `_source.markdown` (RFC-1), with `content_text` as the fallback JSON Feed requires. */
function setMarkdown(item: FeedItem, markdown: string | null) {
  const { markdown: _old, ...source } = isObject(item._source) ? item._source : {}
  item._source = markdown === null ? source : { about: RFC1_URL, ...source, markdown }
  if (markdown !== null && item.content_html === undefined) item.content_text = markdown
}

function checkContent(item: FeedItem) {
  if (item.content_html === undefined && item.content_text === undefined)
    throw new PupsError('invalid_request', 'A comment needs content_html, content_text or markdown (JSON Feed requires content).')
}

/**
 * The owner's RFC-4 submissions (comments, and posts to discussion groups), kept in comment feeds in the app's own
 * directory, never in the owner's main feed (RFC-7 "Comment feeds"): one file per target site and hour,
 * `/appdata/<client-host>/comments/<hash3>/<hash>.json`. Needs the `appdata` scope. Use `session.comments`.
 *
 * ```ts
 * const { source, submission } = await session.comments.post({ target: 'https://rm.example.org/groups/twowaves/posts.json#a8Kd03XpQz', markdown: 'Agreed!' })
 * const status = await session.mentions.submissionStatus(submission!.statusUrl!)
 * ```
 */
export class PupsComments {
  readonly #session: PupsSession

  constructor(session: PupsSession) {
    this.#session = session
  }

  /** The path of the comment feed for a comment on `target` published at `date`. */
  async pathFor(target: string, date: Date | string): Promise<string> {
    return `${this.#session.appDataPath}comments/${await commentFeedPath(target, date)}`
  }

  /**
   * Publishes a comment: adds it at the top of its comment feed, which is created if needed, and submits it to the
   * target, once it is visible at its public URL.
   * @throws {PupsError} `invalid_request` for a bad target or missing content; `invalid_feed` if the file holds
   *   something else; the errors of writing.
   */
  async post(input: CommentInput, options: SubmitOption = {}): Promise<CommentResult> {
    const { target, markdown, ...fields } = input
    const item: FeedItem = { id: randomString(12), ...fields, date_published: now() }
    item._source = { about: RFC1_URL, ...isObject(item._source) ? item._source : {}, inReplyTo: target }
    if (markdown !== undefined) setMarkdown(item, markdown)
    checkContent(item)
    const path = await this.pathFor(target, item.date_published!)
    const feedUrl = this.#session.publicUrl(path)
    await this.#session.update(path, async file => {
      const doc = file ? await this.#feed(file.json(), path) : this.#newFeed(feedUrl)
      return { ...doc, items: [item, ...doc.items] }
    }, { contentType: 'application/feed+json', signal: options.signal })
    return this.#result(feedUrl, path, item, options)
  }

  /** A comment, given by its `source`; undefined if its feed or the item doesn't exist. */
  async get(source: string, options: Signal = {}): Promise<CommentResult | undefined> {
    const { path, id } = this.#parse(source)
    const file = await this.#session.get(path, options)
    const item = file ? (await this.#feed(file.json(), path)).items.find(i => i.id == id) : undefined
    return item && { source, path, item }
  }

  /**
   * Changes a comment in its comment feed, keeping `id`, `date_published` and the target, sets `date_modified`, and
   * submits it again with the same `source`. RFC-4 servers apply it only if the target allows edits.
   * @throws {PupsError} `not_found` if the comment doesn't exist.
   */
  async edit(source: string, changes: CommentChanges | ((item: FeedItem) => FeedItem), options: SubmitOption = {}): Promise<CommentResult> {
    const { path, id } = this.#parse(source)
    let changed: FeedItem | undefined
    await this.#session.update(path, async file => {
      const doc = file ? await this.#feed(file.json(), path) : undefined
      const current = doc?.items.find(i => i.id == id)
      if (!doc || !current) throw new PupsError('not_found', `There is no comment ${source}.`)
      changed = this.#change(structuredClone(current), changes)
      return { ...doc, items: doc.items.map(i => i.id == id ? changed! : i) }
    }, { contentType: 'application/feed+json', signal: options.signal })
    return this.#result(source.slice(0, source.indexOf('#')), path, changed!, options)
  }

  /**
   * Removes a comment from its comment feed, deletes the file once it is empty, and submits again with the same
   * `source`, so that the RFC-4 server deletes the republished comment if the target allows it.
   * @throws {PupsError} `not_found` if the comment doesn't exist.
   */
  async delete(source: string, options: SubmitOption = {}): Promise<CommentResult> {
    const { path, id } = this.#parse(source)
    for (let attempt = 1; ; attempt++) {
      const file = await this.#session.get(path, options)
      const doc = file ? await this.#feed(file.json(), path) : undefined
      const item = doc?.items.find(i => i.id == id)
      if (!file || !doc || !item) throw new PupsError('not_found', `There is no comment ${source}.`)
      const items = doc.items.filter(i => i.id != id)
      try {
        if (items.length) await this.#session.replace(path, { ...doc, items }, file.etag, { contentType: 'application/feed+json', signal: options.signal })
        else await this.#session.delete(path, { ifMatch: file.etag, signal: options.signal })
      } catch (e) {
        if (isPupsError(e, 'precondition_failed') && attempt < 5) continue
        throw e
      }
      return this.#result(source.slice(0, source.indexOf('#')), path, item, options, true)
    }
  }

  /**
   * Submits a comment to its target (RFC-4 "Submitting"), e.g. again after a failure. Waits until its feed shows the
   * comment as it is now, or no longer shows it after a delete, so that the server doesn't fetch an older copy.
   */
  async submit(source: string, target: string, options: Signal & { deleted?: boolean } = {}): Promise<Submission> {
    const mentions = this.#session.mentions
    const { id } = this.#parse(source)
    await mentions.waitForItem(source.slice(0, source.indexOf('#')), id, item => options.deleted ? !item : !!item, options)
    return mentions.submit(source, target, options)
  }

  async #result(feedUrl: string, path: string, item: FeedItem, options: SubmitOption, deleted = false): Promise<CommentResult> {
    const source = `${feedUrl}#${encodeURIComponent(item.id)}`
    const target = inReplyTo(item)
    const submission = options.submit ?? true
      ? target && await this.submit(source, target, { signal: options.signal, deleted })
      : undefined
    return { source, path, item, ...submission ? { submission } : {} }
  }

  #newFeed(feedUrl: string): FeedDocument {
    const host = new URL(this.#session.me).hostname
    return {
      version: JSON_FEED,
      title: `Comments by ${host}`,
      home_page_url: `https://${host}/`,
      feed_url: feedUrl,
      _source: { about: RFC1_URL, accounts: { socialspec: `@${host}` } },
      items: [],
    }
  }

  async #feed(json: Promise<unknown>, path: string): Promise<FeedDocument> {
    const doc = await json.catch(() => undefined)
    if (!isFeed(doc)) throw new PupsError('invalid_feed', `${path} is not a JSON Feed.`)
    return doc
  }

  #change(item: FeedItem, changes: CommentChanges | ((item: FeedItem) => FeedItem)): FeedItem {
    const { id, date_published } = item
    const target = inReplyTo(item)
    if (typeof changes == 'function') item = changes(item)
    else for (const [key, value] of Object.entries(changes)) {
      if (key == 'markdown') value !== undefined && setMarkdown(item, value as string | null)
      else if (value === null) delete (item as Record<string, unknown>)[key]
      else if (value !== undefined) (item as Record<string, unknown>)[key] = value
    }
    checkContent(item)
    // The comment stays the same submission: same id, date, target and therefore file.
    const source = isObject(item._source) ? item._source : {}
    return { ...item, id, date_published, _source: { ...source, inReplyTo: target }, date_modified: now() }
  }

  #parse(source: string): { path: string; id: string } {
    const at = source.indexOf('#')
    const path = at > 0 ? pathFromPublicUrl(this.#session.server, source.slice(0, at)) : undefined
    if (!path || !path.startsWith(`${this.#session.appDataPath}comments/`))
      throw new PupsError('invalid_request', `${source} is not a comment in this app's comment feeds.`)
    return { path, id: decodeURIComponent(source.slice(at + 1)) }
  }
}
