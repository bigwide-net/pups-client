import { PUPS_REL } from './discovery.js'
import { errorFromResponse, PupsError } from './errors.js'
import { pathFromPublicUrl, wellKnownEntryFor } from './paths.js'
import { writeScopePaths } from './scopes.js'
import type { PupsSession } from './session.js'
import { controlChars, fetchWithTimeout, isSameHostOrWww, parseUrl } from './util.js'

/** A link in `host-meta.json` (RFC 6415, JSON form). */
export interface HostMetaLink {
  rel: string
  href?: string
  type?: string
  /** A language tag or `default` → a title (RFC 7033). */
  titles?: Record<string, string>
  properties?: Record<string, string | null>
  [field: string]: unknown
}

/** `host-meta.json` (RFC 6415, JSON form). */
export interface HostMetaDocument {
  subject?: string
  aliases?: string[]
  properties?: Record<string, string | null>
  links?: HostMetaLink[]
  [field: string]: unknown
}

/** Property URIs reserved for PUPS itself. */
const PUPS_PROPERTY_PREFIX = 'https://bigwide.net/ns/pups#'

/** Rels nobody may register through PUPS (RFC-6 "Links"). */
const reservedRels = new Set([PUPS_REL, 'http://webfinger.net/rel/profile-page', 'me', 'authorization_endpoint', 'openid'])

const maxPropertyLength = 2048

/**
 * Edits `host-meta.json` through the server's `host_meta_endpoint` (RFC-6 "Editing host-meta.json").
 *
 * Apps may only add links to their own files, with the rels their scopes allow, and set the properties declared for
 * well-known paths they hold. Which rels are single-valued and which properties take URLs is known only to the
 * server, so those problems surface as `conflict`, `insufficient_scope` or `invalid_request` from the server.
 */
export class HostMetaEditor {
  readonly #session: PupsSession
  readonly #fetch: typeof fetch

  /** @internal */
  constructor(session: PupsSession, fetchFn: typeof fetch) {
    this.#session = session
    this.#fetch = fetchFn
  }

  /** Whether the server can edit `host-meta.json`. If not, the editing methods throw `unsupported`. */
  get available(): boolean {
    return !!this.#session.server.hostMetaEndpoint
  }

  /** Reads the public `/.well-known/host-meta.json` of the owner's domain, e.g. to show the current links. */
  async get(options: { signal?: AbortSignal } = {}): Promise<HostMetaDocument> {
    const url = `${this.#session.server.domain}.well-known/host-meta.json`
    const response = await fetchWithTimeout(this.#fetch, url, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } }, 30_000, options.signal)
    if (response.status == 404) return { links: [] }
    if (!response.ok) throw await errorFromResponse(response, `GET ${url}`)
    return response.json()
  }

  /**
   * Whether the granted scopes allow a link with `rel` to the file `href` (a path or a public URL):
   * for a file under a well-known path, the `rels` declared for it; for a file in the app's own directory, URI rels
   * on the client host (with or without `www.`).
   */
  allowsRel(rel: string, href: string): boolean {
    let path: string
    try {
      path = this.#target(href).path
    } catch {
      return false
    }
    if (reservedRels.has(rel)) return false
    if (path.startsWith(this.#session.appDataPath)) {
      const url = parseUrl(rel)
      return !!url && (url.protocol == 'https:' || url.protocol == 'http:') && isSameHostOrWww(url.hostname, this.#session.clientHost)
    }
    return wellKnownEntryFor(path, this.#session.server.wellKnownPaths)?.rels.includes(rel) ?? false
  }

  /** The properties this session may set: those declared for the well-known paths whose scope was granted. */
  allowedProperties(): string[] {
    const granted = new Set(writeScopePaths(this.#session.scopes))
    const properties = this.#session.server.wellKnownPaths
      .filter(entry => granted.has(entry.path))
      .flatMap(entry => entry.properties)
      .filter(p => !p.startsWith(PUPS_PROPERTY_PREFIX))
    return [...new Set(properties)]
  }

  /** The link properties allowed for links to the file `href` (a path or a public URL): those declared for its well-known path. */
  allowedLinkProperties(href: string): string[] {
    try {
      return wellKnownEntryFor(this.#target(href).path, this.#session.server.wellKnownPaths)?.linkProperties ?? []
    } catch {
      return []
    }
  }

  /**
   * Adds a link to one of the app's files, or changes it if the app added it before: its `type`, `titles` and
   * `properties` are then replaced (omitted ones removed). `href` may be a path (relative paths are in the app's own
   * directory) or a public URL; it is sent as the public URL. `titles` maps language tags or `default` to titles;
   * `properties` may only hold the link properties declared for the file's well-known path.
   * @throws {PupsError} `insufficient_scope` if the file, rel or a property isn't allowed, `conflict` if a single-valued
   *   rel is taken or the link belongs to the owner or another app.
   */
  async addLink(link: { rel: string; href: string; type?: string; titles?: Record<string, string>; properties?: Record<string, string> },
    options: { signal?: AbortSignal } = {}): Promise<void> {
    const { url } = this.#target(link.href)
    if (!this.allowsRel(link.rel, link.href))
      throw new PupsError('insufficient_scope', `The granted scopes don't allow the rel "${link.rel}" for ${url} (RFC-6, Links).`)
    const allowed = this.allowedLinkProperties(link.href)
    const bad = Object.keys(link.properties ?? {}).find(p => !allowed.includes(p))
    if (bad)
      throw new PupsError('insufficient_scope', `The link property "${bad}" isn't allowed for ${url}. Allowed: ${allowed.join(', ') || 'none'} (RFC-6, Links).`)
    await this.#post({
      action: 'add', rel: link.rel, href: url, ...link.type ? { type: link.type } : {},
      ...link.titles ? { titles: link.titles } : {}, ...link.properties ? { properties: link.properties } : {},
    }, `Adding a ${link.rel} link`, options.signal)
  }

  /**
   * Puts the links of `rel` into the order of `hrefs` (public URLs, or paths of files in the scopes). It must list
   * every link of that rel in `host-meta.json` exactly once, the owner's and other apps' included; read them with
   * {@link get} first.
   * @throws {PupsError} `conflict` if `hrefs` doesn't match the current links, `insufficient_scope` if no granted
   *   scope allows the rel.
   */
  async orderLinks(rel: string, hrefs: string[], options: { signal?: AbortSignal } = {}): Promise<void> {
    const urls = hrefs.map(h => /^[a-z][a-z0-9+.-]*:/i.test(h) ? h : this.#target(h).url)
    await this.#post({ action: 'order', rel, hrefs: urls }, `Ordering the ${rel} links`, options.signal)
  }

  /** Removes a link the app added. Links of the owner and of other apps are never touched by the server. */
  async removeLink(link: { rel: string; href: string }, options: { signal?: AbortSignal } = {}): Promise<void> {
    const { url } = this.#target(link.href)
    await this.#post({ action: 'remove', rel: link.rel, href: url }, `Removing a ${link.rel} link`, options.signal)
  }

  /**
   * Sets a shared top-level property. The last write wins; apps can't remove properties, only the owner can.
   * @throws {PupsError} `insufficient_scope` if the property isn't declared for a granted well-known path;
   *   `invalid_request` for an invalid value.
   */
  async setProperty(property: string, value: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.allowedProperties().includes(property))
      throw new PupsError('insufficient_scope', `The granted scopes don't allow setting "${property}". Allowed: ${this.allowedProperties().join(', ') || 'none'} (RFC-6, Properties).`)
    if (typeof value != 'string' || !value || value.length > maxPropertyLength || controlChars.test(value))
      throw new PupsError('invalid_request', `A property value must be a non-empty string of at most ${maxPropertyLength} characters without control characters (RFC-6, Properties).`)
    await this.#post({ action: 'set-property', property, value }, `Setting ${property}`, options.signal)
  }

  /**
   * The path and public URL of a link target, which must be a public file inside the granted scopes.
   * @throws {PupsError} `insufficient_scope`
   */
  #target(href: string): { path: string; url: string } {
    const session = this.#session
    const path = /^[a-z][a-z0-9+.-]*:/i.test(href) ? pathFromPublicUrl(session.server, href) : session.resolve(href)
    if (!path || !session.canWrite(path))
      throw new PupsError('insufficient_scope', `"${href}" is not a file inside the scopes granted to this app. Links may only point to the app's own files (RFC-6, Links).`)
    if (session.isPrivate(path))
      throw new PupsError('insufficient_scope', `"${href}" is private: it has no public URL and can't be linked (RFC-6, Private areas).`)
    return { path, url: session.publicUrl(path) }
  }

  async #post(body: Record<string, unknown>, what: string, signal?: AbortSignal) {
    const endpoint = this.#session.server.hostMetaEndpoint
    if (!endpoint) throw new PupsError('unsupported', `${new URL(this.#session.server.domain).host}'s server can't edit host-meta.json.`)
    const response = await this.#session._authorized(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, signal)
    if (!response.ok) throw await errorFromResponse(response, what)
  }
}
