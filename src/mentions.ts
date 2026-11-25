import type { FeedItem } from './feed.js'
import { accountHost, asciiHost, itemHandles, type HandleSource } from './handles.js'
import { isPupsError, PupsError } from './errors.js'
import { fetchWithTimeout, isObject, sleep } from './util.js'

/** The link relation of the mention endpoint in `host-meta.json` (RFC-11 "Discovery"). A placeholder in RFC-11. */
export const MENTION_REL = 'https://bigwide.net/ns/mention'

/** RFC-11: senders should notify at most this many accounts per post. */
const MAX_ACCOUNTS = 20
/** RFC-4 "Archived items": servers follow at least 10 pages; so does the sender looking for an item. */
const MAX_PAGES = 10
const DAY_MS = 24 * 3600_000
const HOUR_MS = 3600_000
const MAX_FEED_BYTES = 2_000_000

export interface MentionsOptions {
  fetch?: typeof fetch
  /**
   * The waits before the retries of a webmention after a network error, a `5xx` or a `429` (RFC-11 "When").
   * A longer `Retry-After` is respected, up to 10 minutes. Default: 10 seconds, 1 minute, 5 minutes.
   */
  retryDelays?: number[]
  /**
   * The waits between the checks whether a new or changed post is visible at its public URL, before the mentions
   * are sent (RFC-11 "When"). Default: 1, 2, 4, 8 and 15 seconds, so about half a minute.
   */
  visibilityDelays?: number[]
  /** Timeout of each request, in milliseconds. Default 15 seconds. */
  timeoutMs?: number
  /** The publisher's identity, e.g. `https://tim.example.com/`: never notified. `session.mentions` sets it. */
  me?: string
}

/**
 * The result of sending a webmention:
 * - `accepted`: the endpoint answered `2xx`.
 * - `unknown`: sent, but the endpoint doesn't allow a browser to read its answer (no CORS headers).
 * - `rejected`: the endpoint answered `4xx` (other than `429`); not retried.
 * - `failed`: a network error, `5xx` or `429`, also after the retries.
 */
export type DeliveryStatus = 'accepted' | 'unknown' | 'rejected' | 'failed'

export interface Delivery {
  status: DeliveryStatus
  /** The HTTP status, if there was a readable answer. */
  httpStatus?: number
  /** The `message` of a JSON error body, or what went wrong. */
  message?: string
  /** The `error` of a JSON error body, e.g. an RFC-4 failure code such as `comments-disabled`. */
  code?: string
  /** The `Location` header of the answer, e.g. an RFC-4 status page. */
  location?: string
}

/** An account a post would notify, from `plan()`: e.g. to ask the author before anything is sent. */
export interface PlannedMention {
  /** The account, e.g. `@tim.example.com`. */
  account: string
  /** `reply` if the post answers an item of the account, `mention` if it names it. */
  kind: 'mention' | 'reply'
  /** The webmention's target: the domain's root URL, or the answered item. */
  target: string
  /** The mention endpoint; set by `plan()` with `discover`, and on reports of accounts that have one. */
  endpoint?: string
}

/** One account notified by `notifyAll()` or `sendPlanned()`, or skipped because its domain doesn't accept mentions. */
export interface MentionReport extends PlannedMention {
  /** `no-endpoint` if the domain doesn't accept mentions (no link in `host-meta.json`, or it can't be read). */
  status: DeliveryStatus | 'no-endpoint'
  httpStatus?: number
  message?: string
}

/** The answer to an RFC-4 submission. */
export interface Submission extends Delivery {
  /** The endpoint from the target feed's `_submissions.url`. */
  endpoint: string
  /** The status page (RFC-4 "Response and status"), from `Location`; poll it with `submissionStatus()`. */
  statusUrl?: string
  /** The guid the item will have when it is republished. */
  guid?: string
}

/** An RFC-4 status page. */
export type SubmissionStatus =
  | { status: 'waiting' }
  | { status: 'success'; pubDate?: string; pubUrl?: string }
  | { status: 'deleted' }
  | { status: 'failure'; code?: string; text?: string }

/** An item found in a feed, with what decides about mentions and submissions. */
export interface FoundItem {
  /** The URL of the feed or archive that was fetched first. */
  feedUrl: string
  /** The RFC-4 `_submissions` that apply: the feed's, or for an RFC-7 archive, those of its feed file. */
  submissions?: Record<string, unknown>
  /** The item, if it was found. */
  item?: FeedItem
  /** The host of the item's author (RFC-11 "Replies"): its own socialspec account, else the feed's if the feed has no `_submissions`. */
  author?: string
  /** False if the item's author declined reply mentions, with RFC-4 `_commenting.notifyReplies: false` (RFC-11 "Opting out"). */
  notifyReplies?: boolean
}

interface Feed {
  url: string
  doc: Record<string, unknown>
}

/** What decides about the mentions of a post: its title, content and `_source.inReplyTo`. A `FeedItem` or a `PostInput`. */
export type MentionSource = HandleSource & { _source?: unknown }

/** The input of `plan()`: a post to be added (`item`), changed (`item` and `previous`) or deleted (`previous`). */
export interface PostChange {
  /** The post as it will be published; undefined for a delete. */
  item?: MentionSource
  /** The post before an edit or delete. */
  previous?: MentionSource
  /** The publisher's identity; never notified. Default: the `me` of the options. */
  me?: string
}

/** The input of `notifyAll()`: a post that was added, changed or deleted, and its `source`. */
export interface PostMentions extends PostChange {
  /** The post's `source`: its feed or archive URL plus `#<id>`. */
  source: string
}

const protocolOf = (url: unknown) => {
  try {
    return typeof url == 'string' ? new URL(url).protocol : undefined
  } catch {
    return undefined
  }
}
const isHttps = (url: unknown): url is string => protocolOf(url) == 'https:'
const isHttpUrl = (url: unknown): url is string => isHttps(url) || protocolOf(url) == 'http:'

const inReplyTo = (item?: MentionSource) => isObject(item?._source) && typeof item._source.inReplyTo == 'string' ? item._source.inReplyTo : undefined
const notifyReplies = (item: FeedItem) => !(isObject(item._commenting) && item._commenting.notifyReplies === false)
const socialspec = (o: unknown) => isObject(o) && isObject(o._source) && isObject(o._source.accounts) ? o._source.accounts.socialspec : undefined
const retryable = (status: number) => status == 429 || status >= 500

/** Splits `https://x.example/feed.json#p-1` into the feed URL and the decoded id. */
function splitRef(ref: string): [string, string | undefined] {
  const at = ref.indexOf('#')
  if (at < 0) return [ref, undefined]
  let id = ref.slice(at + 1)
  try {
    id = decodeURIComponent(id)
  } catch { /* keep it as it is */ }
  return [ref.slice(0, at), id]
}

/** A field of a feed's RFC-13 `_archive`. */
const archiveField = (doc: Record<string, unknown>, key: string): unknown => isObject(doc._archive) ? doc._archive[key] : undefined

/**
 * Sends webmentions: RFC-11 mentions to the domains a post names or answers, found through their `host-meta.json`,
 * and RFC-4 submissions to the endpoint a target feed names in `_submissions`. Plain Webmention, form-encoded.
 *
 * Use `session.mentions`, which shares the discovery cache of the session, or create one for use without a session.
 * In a browser, it can only read feeds and `host-meta.json` files that allow CORS, as RFC-4 and RFC-6 require;
 * domains whose `host-meta.json` doesn't count as having no endpoint (RFC-11 "CORS").
 */
export class Mentions {
  readonly #fetch: typeof fetch
  readonly #retryDelays: number[]
  readonly #visibilityDelays: number[]
  readonly #timeoutMs: number
  readonly #endpoints = new Map<string, { endpoint?: string; until: number }>()
  readonly #me?: string

  constructor(options: MentionsOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#retryDelays = options.retryDelays ?? [10_000, 60_000, 300_000]
    this.#visibilityDelays = options.visibilityDelays ?? [1000, 2000, 4000, 8000, 15_000]
    this.#timeoutMs = options.timeoutMs ?? 15_000
    this.#me = options.me
  }

  /**
   * The mention endpoint of a domain (RFC-11 "Discovery"): the first link with the relation `MENTION_REL` in its
   * `host-meta.json`, if it is an https URL. Undefined if the domain has none, or its `host-meta.json` can't be
   * read. Cached for 24 hours (less if the file's `max-age` says so), failures for an hour.
   * @param domain `tim.example.com`, `@tim.example.com` or `https://tim.example.com/`.
   */
  async discover(domain: string, options: { signal?: AbortSignal } = {}): Promise<string | undefined> {
    const host = asciiHost(domain.replace(/^@/, '').replace(/^https:\/\//i, '').replace(/\/$/, ''))
    if (!host) return undefined
    const cached = this.#endpoints.get(host)
    if (cached && cached.until > Date.now()) return cached.endpoint
    const url = `https://${host}/.well-known/host-meta.json`
    let endpoint: string | undefined
    let maxAge = DAY_MS
    try {
      const response = await fetchWithTimeout(this.#fetch, url, { credentials: 'omit', headers: { Accept: 'application/json' } }, this.#timeoutMs, options.signal)
      // Only host-meta.json on the domain itself counts (RFC-11 "Discovery").
      if (response.ok && (!response.url || new URL(response.url).host == host)) {
        const doc: unknown = await response.json()
        const link = isObject(doc) && Array.isArray(doc.links) ? doc.links.find(l => isObject(l) && l.rel == MENTION_REL) : undefined
        endpoint = isHttps(link?.href) ? link.href : undefined
        const age = /max-age=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')
        if (age) maxAge = Math.min(maxAge, Number(age[1]) * 1000)
      }
    } catch (e) {
      if (isPupsError(e, 'aborted')) throw e
    }
    this.#endpoints.set(host, { endpoint, until: Date.now() + (endpoint ? maxAge : Math.max(maxAge, HOUR_MS)) })
    return endpoint
  }

  /**
   * Sends a webmention: a form-encoded `POST` with `source` and `target`. Retries after network errors, `5xx` and
   * `429` with the `retryDelays` (unless `retry` is false), never after other answers. Never throws, except
   * `aborted`.
   */
  async send(endpoint: string, source: string, target: string, options: { signal?: AbortSignal; retry?: boolean } = {}): Promise<Delivery> {
    return (await this.#sendWithBody(endpoint, source, target, options)).delivery
  }

  async #sendWithBody(endpoint: string, source: string, target: string, options: { signal?: AbortSignal; retry?: boolean }) {
    const delays = options.retry === false ? [] : this.#retryDelays
    for (let attempt = 0; ; attempt++) {
      const answer = await this.#post(endpoint, source, target, options.signal)
      if (answer.delivery.status != 'failed' || attempt >= delays.length) return answer
      await sleep(Math.max(delays[attempt]!, Math.min(answer.retryAfterMs, 600_000)), options.signal)
    }
  }

  async #post(endpoint: string, source: string, target: string, signal?: AbortSignal): Promise<{ delivery: Delivery; json?: unknown; retryAfterMs: number }> {
    const body = () => new URLSearchParams({ source, target })
    let response: Response
    try {
      response = await fetchWithTimeout(this.#fetch, endpoint, { method: 'POST', body: body(), credentials: 'omit' }, this.#timeoutMs, signal)
    } catch (e) {
      if (isPupsError(e, 'aborted')) throw e
      // A browser hides the answer of an endpoint without CORS headers, but a form-encoded POST is a simple request
      // and reaches it anyway: send it without reading the answer.
      try {
        await fetchWithTimeout(this.#fetch, endpoint, { method: 'POST', body: body(), credentials: 'omit', mode: 'no-cors' }, this.#timeoutMs, signal)
        return { delivery: { status: 'unknown', message: 'Sent, but the endpoint doesn\'t let a browser read its answer.' }, retryAfterMs: 0 }
      } catch (again) {
        if (isPupsError(again, 'aborted')) throw again
        return { delivery: { status: 'failed', message: e instanceof Error ? e.message : String(e) }, retryAfterMs: 0 }
      }
    }
    const location = response.headers.get('Location')
    const json: unknown = await response.json().catch(() => undefined)
    const delivery: Delivery = {
      status: response.ok ? 'accepted' : retryable(response.status) ? 'failed' : 'rejected',
      httpStatus: response.status,
      ...location ? { location: new URL(location, endpoint).href } : {},
      ...!response.ok && isObject(json) && typeof json.message == 'string' ? { message: json.message } : {},
      ...!response.ok && isObject(json) && typeof json.error == 'string' ? { code: json.error } : {},
    }
    return { delivery, json, retryAfterMs: (Number(response.headers.get('Retry-After')) || 0) * 1000 }
  }

  /**
   * Tells a domain that `source` names it (RFC-11 "Mentions by name"), or answers its item `target`. Discovers
   * the endpoint and sends the webmention.
   * @param account `@tim.example.com` (or the bare host).
   * @param target Default: the domain's root URL, `https://tim.example.com/`.
   */
  async notify(source: string, account: string, options: { target?: string; signal?: AbortSignal; retry?: boolean } = {}): Promise<MentionReport> {
    const host = asciiHost(account.replace(/^@/, '')) ?? account.replace(/^@/, '')
    const planned: PlannedMention = { account: `@${host}`, kind: options.target ? 'reply' : 'mention', target: options.target ?? `https://${host}/` }
    return (await this.sendPlanned(source, [planned], options))[0]!
  }

  /**
   * Tells the author of the item `target` (a feed URL plus `#<id>`) that `source` answers it (RFC-11 "Replies").
   * @returns undefined if the item has no author to notify (or says `notifyReplies: false`), can't be read, or its feed takes RFC-4 submissions:
   *   then the answer is a submission, and the RFC-4 server sends the mentions.
   */
  async reply(source: string, target: string, options: { signal?: AbortSignal; retry?: boolean } = {}): Promise<MentionReport | undefined> {
    const found = await this.findItem(target, options).catch(e => {
      if (isPupsError(e, 'aborted')) throw e
      return undefined
    })
    return found?.author && found.notifyReplies && !found.submissions ? this.notify(source, found.author, { ...options, target }) : undefined
  }

  /**
   * Submits a comment or post to an RFC-4 feed (RFC-4 "Submitting"): `source` is the item in the author feed,
   * `target` the answered item (feed URL plus `#<id>`), or the group feed for a new post. The endpoint is the
   * target feed's `_submissions.url`, unless given. The app must have shown the target's terms of service and what
   * `republish` means before the first submission (RFC-4 "Republishing").
   * @throws {PupsError} `unsupported` if the target feed takes no submissions.
   */
  async submit(source: string, target: string, options: { endpoint?: string; signal?: AbortSignal } = {}): Promise<Submission> {
    let endpoint = options.endpoint
    if (!endpoint) {
      const submissions = (await this.findItem(target, { ...options, item: false })).submissions
      if (!isHttpUrl(submissions?.url))
        throw new PupsError('unsupported', `${splitRef(target)[0]} takes no submissions: it has no _submissions with a url (RFC-4).`)
      endpoint = submissions!.url as string
    }
    const { delivery, json } = await this.#sendWithBody(endpoint, source, target, { signal: options.signal, retry: false })
    const statusUrl = delivery.location ?? (isObject(json) && typeof json.statusUrl == 'string' ? json.statusUrl : undefined)
    const guid = isObject(json) && typeof json.guid == 'string' ? json.guid : undefined
    return { ...delivery, endpoint, ...statusUrl ? { statusUrl } : {}, ...guid ? { guid } : {} }
  }

  /** Reads an RFC-4 status page. */
  async submissionStatus(statusUrl: string, options: { signal?: AbortSignal } = {}): Promise<SubmissionStatus> {
    const response = await fetchWithTimeout(this.#fetch, statusUrl, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } }, this.#timeoutMs, options.signal)
    const json: unknown = await response.json().catch(() => undefined)
    if (!isObject(json) || typeof json.status != 'string')
      throw new PupsError('invalid_request', `${statusUrl} is not an RFC-4 status page (HTTP ${response.status}).`)
    return json as SubmissionStatus
  }

  /**
   * The accounts a post that is added, changed or deleted would notify (RFC-11 "Who is mentioned"), without sending
   * anything, e.g. to list them in a confirmation dialog before posting: every domain its title and text name
   * (RFC-11 "Handles"), and the author of the item it answers, with a reply, unless the item says `notifyReplies: false`
   * (RFC-4 `_commenting`; mentions by name still go out). After an edit or delete, every account
   * the old or the new version mentions. Each account once, replies first, never `me`, at most 20.
   *
   * Empty if the post answers an item of a feed with RFC-4 `_submissions`: such a post is a submission, and the
   * RFC-4 server sends the mentions once it republishes it (RFC-11 "Who sends").
   *
   * Finding the author of an answered item reads its feed. With `discover`, it also looks up each domain's endpoint,
   * and leaves out the domains that don't accept mentions; that tells them that a post names them, before the post
   * is published (RFC-11 "Privacy considerations").
   */
  async plan(post: PostChange, options: { signal?: AbortSignal; discover?: boolean } = {}): Promise<PlannedMention[]> {
    const me = post.me ?? this.#me
    const own = me ? asciiHost(new URL(me).hostname) : undefined
    const replies = new Map<string, string>()
    for (const target of new Set([inReplyTo(post.item), inReplyTo(post.previous)].filter((t): t is string => !!t?.includes('#')))) {
      const found = await this.findItem(target, options).catch(e => {
        if (isPupsError(e, 'aborted')) throw e
        return undefined
      })
      if (found?.submissions) return []
      if (found?.author && found.notifyReplies && found.author != own && !replies.has(found.author)) replies.set(found.author, target)
    }
    const names = [...new Set([...post.item ? itemHandles(post.item) : [], ...post.previous ? itemHandles(post.previous) : []])]
      .filter(host => host != own && !replies.has(host))
    const planned: PlannedMention[] = [
      ...[...replies].map(([host, target]) => ({ account: `@${host}`, kind: 'reply' as const, target })),
      ...names.map(host => ({ account: `@${host}`, kind: 'mention' as const, target: `https://${host}/` })),
    ].slice(0, MAX_ACCOUNTS)
    if (!options.discover) return planned
    const endpoints = await Promise.all(planned.map(p => this.discover(p.account, options)))
    return planned.flatMap((p, i) => endpoints[i] ? [{ ...p, endpoint: endpoints[i] }] : [])
  }

  /**
   * Sends mentions as `plan()` returned them, e.g. those the author confirmed, with `source` as the post: the
   * post's feed or archive URL plus `#<id>`, once it is published.
   */
  sendPlanned(source: string, planned: PlannedMention[], options: { signal?: AbortSignal; retry?: boolean } = {}): Promise<MentionReport[]> {
    return Promise.all(planned.map(async p => {
      const endpoint = p.endpoint ?? await this.discover(p.account, options)
      if (!endpoint) return { ...p, status: 'no-endpoint' as const }
      const { status, httpStatus, message } = await this.send(endpoint, source, p.target, options)
      return { ...p, endpoint, status, ...httpStatus ? { httpStatus } : {}, ...message ? { message } : {} }
    }))
  }

  /** `plan()` and `sendPlanned()` in one: sends the RFC-11 mentions of a post that was added, changed or deleted. */
  async notifyAll(post: PostMentions, options: { signal?: AbortSignal } = {}): Promise<MentionReport[]> {
    return this.sendPlanned(post.source, await this.plan(post, options), options)
  }

  /**
   * Finds an item, given as feed URL plus `#<id>`, as RFC-4 does: in the feed, then along `next_url` (or RFC-13's
   * `_archive.archive_url`) on the same host, at most 10 pages. JSON Feed only.
   * @throws {PupsError} `network`, `not_found` or `invalid_feed` if the first feed can't be read.
   */
  async findItem(ref: string, options: { signal?: AbortSignal; item?: boolean } = {}): Promise<FoundItem> {
    const [url, id] = splitRef(ref)
    const first = await this.#readFeed(url, options.signal)
    // An RFC-13 archive takes its _submissions from its feed file (RFC-7 "Receiving comments").
    let owner = first
    const updates = archiveField(first.doc, 'updates_url')
    if (typeof updates == 'string') {
      const feedUrl = new URL(updates, first.url)
      owner = feedUrl.host == new URL(first.url).host ? await this.#readFeed(feedUrl.href, options.signal).catch(() => ({ url: feedUrl.href, doc: {} })) : { url: feedUrl.href, doc: {} }
    }
    const submissions = isObject(owner.doc._submissions) ? owner.doc._submissions : undefined
    const result: FoundItem = { feedUrl: first.url, ...submissions ? { submissions } : {} }
    if (options.item === false || id === undefined) return result
    const seen = new Set<string>()
    let feed: Feed | undefined = first
    for (let page = 0; feed && page < MAX_PAGES; page++) {
      seen.add(feed.url)
      const items: unknown[] = Array.isArray(feed.doc.items) ? feed.doc.items : []
      const item = items.find((i): i is FeedItem => isObject(i) && i.id == id)
      if (item) {
        const author = accountHost(socialspec(item)) ?? (submissions ? undefined : accountHost(socialspec(owner.doc)))
        return { ...result, item, ...author ? { author } : {}, notifyReplies: notifyReplies(item) }
      }
      const next: unknown = feed.doc.next_url ?? archiveField(feed.doc, 'archive_url')
      if (typeof next != 'string') break
      const nextUrl: URL = new URL(next, feed.url)
      if (nextUrl.host != new URL(url).host || seen.has(nextUrl.href)) break
      feed = await this.#readFeed(nextUrl.href, options.signal).catch(e => {
        if (isPupsError(e, 'aborted')) throw e
        return undefined
      })
    }
    return result
  }

  async #readFeed(url: string, signal?: AbortSignal): Promise<Feed> {
    const response = await fetchWithTimeout(this.#fetch, url, { credentials: 'omit', headers: { Accept: 'application/feed+json, application/json' } }, this.#timeoutMs, signal)
    if (!response.ok) throw new PupsError('not_found', `${url} answered HTTP ${response.status}.`)
    const text = await response.text()
    if (text.length > MAX_FEED_BYTES) throw new PupsError('invalid_feed', `${url} is too large.`)
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      doc = undefined
    }
    if (!isObject(doc) || typeof doc.version != 'string' || !doc.version.startsWith('https://jsonfeed.org/version/'))
      throw new PupsError('invalid_feed', `${url} is not a JSON Feed.`)
    return { url, doc }
  }

  /**
   * Waits until the item `id` at the public URL `feedUrl` is in the state `ready` wants, e.g. present after a post,
   * so that a receiver that fetches it right away doesn't get an older copy from a cache (RFC-11 "When"). Gives up
   * after the `visibilityDelays`, or at once if the feed can't be read.
   */
  async waitForItem(feedUrl: string, id: string, ready: (item: FeedItem | undefined) => boolean, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      let doc: Record<string, unknown>
      try {
        const response = await fetchWithTimeout(this.#fetch, feedUrl, { credentials: 'omit', cache: 'no-store' }, this.#timeoutMs, options.signal)
        if (!response.ok) return false
        doc = await response.json()
      } catch (e) {
        if (isPupsError(e, 'aborted')) throw e
        return false
      }
      const items: unknown[] = Array.isArray(doc?.items) ? doc.items : []
      if (ready(items.find((i): i is FeedItem => isObject(i) && i.id == id))) return true
      if (attempt >= this.#visibilityDelays.length) return false
      await sleep(this.#visibilityDelays[attempt]!, options.signal)
    }
  }
}
