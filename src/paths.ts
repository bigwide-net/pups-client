import { PupsError } from './errors.js'
import type { PupsServer, WellKnownPath } from './discovery.js'
import { controlChars } from './util.js'

const maxPathBytes = 512

const invalid = (path: string, reason: string) =>
  new PupsError('invalid_path', `Invalid path "${path}": ${reason} (RFC-6, Paths).`)

/**
 * Turns a path as apps pass it into an absolute path below `storage_base`.
 * A path that starts with `/` is absolute; any other path is relative to the app's own directory.
 */
export const resolvePath = (path: string, appDataPath: string) => path.startsWith('/') ? path : appDataPath + path

/** Whether `path` is a single file declared in `well_known_paths` under `/.well-known/`. */
const isDeclaredWellKnownFile = (path: string, wellKnownPaths: readonly WellKnownPath[]) =>
  path.startsWith('/.well-known/') && wellKnownPaths.some(w => w.path == path)

/**
 * Applies the path rules of RFC-6 to an absolute, unencoded path. The server applies them too, and stays
 * authoritative; checking here gives immediate, explained errors. Rejecting dot segments here also means that
 * the URL the library sends always names exactly this path, because nothing is left for `fetch` to resolve.
 * @throws {PupsError} `invalid_path`
 */
export function validatePath(path: string, wellKnownPaths: readonly WellKnownPath[]): void {
  if (!path.startsWith('/')) throw invalid(path, 'it must start with "/"')
  try {
    encodeURIComponent(path)
  } catch {
    throw invalid(path, 'it is not valid UTF-8')
  }
  if (new TextEncoder().encode(path).length > maxPathBytes) throw invalid(path, `it is longer than ${maxPathBytes} bytes`)
  if (path.endsWith('/')) throw invalid(path, 'it ends with "/"; directories can\'t be written')
  if (controlChars.test(path)) throw invalid(path, 'it contains a control character')
  if (/[\\:]/.test(path)) throw invalid(path, 'it contains "\\" or ":"')
  const wellKnownFile = isDeclaredWellKnownFile(path, wellKnownPaths)
  for (const segment of path.slice(1).split('/')) {
    if (!segment) throw invalid(path, 'it has an empty segment')
    if (segment == '.' || segment == '..') throw invalid(path, `it has a "${segment}" segment`)
    if (segment.startsWith('.') && !wellKnownFile) throw invalid(path, `segment "${segment}" starts with a dot`)
    if (/[. ]$/.test(segment)) throw invalid(path, `segment "${segment}" ends with a dot or a space`)
  }
}

/** Percent-encodes each segment of an absolute path, keeping the slashes. */
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** Decodes each segment of an encoded path. */
const decodePath = (path: string) => path.split('/').map(decodeURIComponent).join('/')

/**
 * Whether the scope path (of a `write:` scope) covers `path`. A scope path ending in `/` covers its subtree,
 * any other covers exactly one file. Comparison is segment by segment, because directory scopes end with `/`.
 */
export const scopeCovers = (scopePath: string, path: string) =>
  scopePath.endsWith('/') ? path.startsWith(scopePath) : path == scopePath

/** The declared well-known entry that covers `path`, the most specific one if several do. */
export function wellKnownEntryFor(path: string, wellKnownPaths: readonly WellKnownPath[]): WellKnownPath | undefined {
  let best: WellKnownPath | undefined
  for (const entry of wellKnownPaths)
    if (scopeCovers(entry.path, path) && (!best || entry.path.length > best.path.length)) best = entry
  return best
}

/**
 * Whether an absolute path is in a private area (RFC-6 "Private areas"): `/pups/private/…`, or the `private/`
 * folder of an app's own directory, `/appdata/<client-host>/private/…`. Private files are read only with a token
 * whose scope covers them, and have no public URL. Case-insensitive, like the servers, whose disk may be.
 */
export const isPrivate = (path: string) => /^\/(pups\/private\/|appdata\/[^/]+\/private\/[^/])/i.test(path)

/** The URL where `path` is written (RFC-6 "Upload API"). */
export const storageUrl = (server: PupsServer, path: string) => server.storageBase + encodePath(path).slice(1)

/**
 * The URL where readers find `path` (RFC-6 "Public URLs"): `public_base` + path, or, for a file under a
 * well-known entry with a `url`, that `url` plus the rest of the path.
 * @throws {PupsError} `invalid_path` for a private file, which has no public URL.
 */
export function publicUrl(server: PupsServer, path: string): string {
  if (isPrivate(path))
    throw new PupsError('invalid_path', `${path} is private and has no public URL. Read it with get() (RFC-6, Private areas).`)
  const entry = wellKnownEntryFor(path, server.wellKnownPaths)
  if (entry?.url) return entry.url + encodePath(path.slice(entry.path.length))
  return server.publicBase + encodePath(path).slice(1)
}

/**
 * The path of a public URL, the reverse of {@link publicUrl}, or undefined if the URL is not a public file of this
 * server. Private files have no public URL, so a URL that maps to one is not a public file either.
 */
export function pathFromPublicUrl(server: PupsServer, url: string): string | undefined {
  const path = mapPublicUrl(server, url)
  return path && !isPrivate(path) ? path : undefined
}

function mapPublicUrl(server: PupsServer, url: string): string | undefined {
  try {
    const entries = server.wellKnownPaths.filter(w => w.url).sort((a, b) => b.url!.length - a.url!.length)
    for (const entry of entries)
      if (entry.path.endsWith('/') ? url.startsWith(entry.url!) : url == entry.url)
        return entry.path + decodePath(url.slice(entry.url!.length))
    if (url.startsWith(server.publicBase)) return '/' + decodePath(url.slice(server.publicBase.length))
  } catch {
    // Malformed percent-encoding: not one of our URLs.
  }
  return
}
