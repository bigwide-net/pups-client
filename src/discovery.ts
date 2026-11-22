import { PupsError } from './errors.js'
import { fetchWithTimeout, parseUrl } from './util.js'

/** The link relation in `host-meta.json` that points to the PUPS configuration document. A placeholder in RFC-6 0.1. */
export const PUPS_REL = 'https://bigwide.net/ns/personal-storage'

/** The `spec_version` values this library implements. */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = ['0.1']

const discoveryTimeoutMs = 10_000

/** An entry of `well_known_paths` (RFC-6 "Well-known paths"). */
export interface WellKnownPath {
  /** The scope path. Ends with `/` for a directory. */
  path: string
  /** The public URL of the file or directory, if it differs from `public_base` + path. */
  url?: string
  /** Link relations apps with this scope may register in `host-meta.json`. */
  rels: string[]
  /** Top-level `host-meta.json` properties apps with this scope may set. */
  properties: string[]
  /** Properties apps with this scope may set on their links to files under this path. */
  linkProperties: string[]
}

/** A discovered and validated PUPS server: the configuration document, plus what discovery learned. Plain JSON data. */
export interface PupsServer {
  /** The normalized domain the user entered, `https://<host>/`. */
  domain: string
  /** The hosts `me` may name: the entered host, plus the final host if `host-meta.json` was redirected. */
  identityHosts: string[]
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string
  /** Base URL for writes. Ends with `/`. */
  storageBase: string
  /** Base URL for public reads. Ends with `/`. */
  publicBase: string
  scopesSupported: string[]
  wellKnownPaths: WellKnownPath[]
  /** Where apps edit `host-meta.json`; absent if the server can't write it. */
  hostMetaEndpoint?: string
  /** Present only if the server can't accept `PUT` and `DELETE`; all writes then go here. */
  postEndpoint?: string
  /**
   * Present if the server accepts RFC-4 comments on posts of the owner's feeds and writes them into the owner's inbox
   * (RFC-6 "Built-in receiver"). Feeds opt in with `feed.enableComments()`.
   */
  commentEndpoint?: string
  maxUploadBytes: number
  specVersion: string
  /** The configuration document as fetched, including fields this library doesn't know. */
  raw: Record<string, unknown>
}

/**
 * Normalizes what the user typed (`tim.example.com`, `https://tim.example.com/some/page`) to `https://<host>/`,
 * as RFC-6 "Starting point" requires: HTTPS, lowercase host, IDNs in ASCII form, no port, path, query or fragment.
 * @throws {PupsError} `invalid_domain`
 */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim()
  const url = parseUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (!url || (url.protocol != 'https:' && url.protocol != 'http:') || !url.hostname)
    throw new PupsError('invalid_domain', `"${input}" is not a domain name. Enter something like "example.com".`)
  // The URL parser lowercases the host and converts IDNs to punycode.
  const host = url.hostname.replace(/\.$/, '')
  if (!host.includes('.') && !host.startsWith('['))
    throw new PupsError('invalid_domain', `"${input}" is not a full domain name. Enter something like "example.com".`)
  return `https://${host}/`
}

async function fetchJson(fetchFn: typeof fetch, url: string, signal: AbortSignal | undefined, notFound: () => PupsError) {
  const response = await fetchWithTimeout(fetchFn, url, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-cache',
  }, discoveryTimeoutMs, signal)
  // Browsers follow redirects without exposing the chain; at least the final URL must be HTTPS.
  if (response.url && !response.url.startsWith('https://'))
    throw new PupsError('no_pups_server', `${url} redirected to a non-HTTPS URL.`)
  if (!response.ok) throw notFound()
  try {
    return { json: await response.json() as unknown, finalUrl: response.url || url }
  } catch {
    throw notFound()
  }
}

/**
 * Discovers the PUPS server of a domain (RFC-6 "Discovery"): fetches `/.well-known/host-meta.json`, follows the
 * PUPS link, and validates the configuration document.
 */
export async function discover(domain: string, fetchFn: typeof fetch, signal?: AbortSignal): Promise<PupsServer> {
  const normalized = normalizeDomain(domain)
  const hostMetaUrl = `${normalized}.well-known/host-meta.json`
  const noServer = () => new PupsError('no_pups_server', `${new URL(normalized).host} has no Personal Upload Server: ${hostMetaUrl} is missing, not readable from the browser, or has no PUPS link.`)
  const hostMeta = await fetchJson(fetchFn, hostMetaUrl, signal, noServer)
  const links = (hostMeta.json as { links?: unknown })?.links
  const link = Array.isArray(links)
    ? links.find((l: { rel?: unknown }) => l && l.rel == PUPS_REL) as { href?: unknown } | undefined
    : undefined
  const configUrl = parseUrl(link?.href)
  if (!configUrl) throw noServer()
  if (configUrl.protocol != 'https:')
    throw new PupsError('invalid_server_config', `The PUPS link in ${hostMetaUrl} must be an HTTPS URL.`)
  const config = await fetchJson(fetchFn, configUrl.href, signal,
    () => new PupsError('invalid_server_config', `The PUPS configuration document ${configUrl.href} can't be read.`))
  const identityHosts = [new URL(normalized).hostname]
  const finalHost = new URL(hostMeta.finalUrl).hostname
  if (!identityHosts.includes(finalHost)) identityHosts.push(finalHost)
  return parseConfig(config.json, normalized, identityHosts)
}

/**
 * Validates a configuration document (RFC-6 "Configuration document"). Unknown fields are kept in `raw` and
 * otherwise ignored.
 * @throws {PupsError} `invalid_server_config`, `unsupported_server_version`
 */
export function parseConfig(json: unknown, domain: string, identityHosts: string[]): PupsServer {
  if (!json || typeof json != 'object' || Array.isArray(json))
    throw new PupsError('invalid_server_config', 'The PUPS configuration document is not a JSON object.')
  const raw = json as Record<string, unknown>
  const fail = (field: string, problem: string): never => {
    throw new PupsError('invalid_server_config', `PUPS configuration: "${field}" ${problem}.`)
  }
  const https = (field: string, value = raw[field]) => {
    const url = parseUrl(value)
    if (!url || url.protocol != 'https:' || url.hash) return fail(field, 'must be an HTTPS URL without fragment')
    return value as string
  }
  const optionalHttps = (field: string) => raw[field] === undefined ? undefined : https(field)
  const base = (field: string) => https(field).endsWith('/') ? raw[field] as string : fail(field, 'must end with "/"')
  const strings = (field: string, value: unknown) =>
    Array.isArray(value) && value.every(v => typeof v == 'string') ? value as string[] : fail(field, 'must be an array of strings')

  const specVersion = typeof raw.spec_version == 'string' ? raw.spec_version : fail('spec_version', 'is missing')
  if (!SUPPORTED_SPEC_VERSIONS.includes(specVersion))
    throw new PupsError('unsupported_server_version', `The server implements PUPS ${specVersion}; this library supports ${SUPPORTED_SPEC_VERSIONS.join(', ')}.`)

  const issuer = https('issuer')
  if (new URL(issuer).search) fail('issuer', 'must not have a query')
  const maxUploadBytes = raw.max_upload_bytes
  if (typeof maxUploadBytes != 'number' || !Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0)
    fail('max_upload_bytes', 'must be a positive integer')

  const wellKnownRaw = raw.well_known_paths ?? []
  if (!Array.isArray(wellKnownRaw)) fail('well_known_paths', 'must be an array')
  const wellKnownPaths = (wellKnownRaw as unknown[]).map((entry, i): WellKnownPath => {
    const field = `well_known_paths[${i}]`
    if (!entry || typeof entry != 'object') return fail(field, 'must be an object')
    const e = entry as Record<string, unknown>
    if (typeof e.path != 'string' || !e.path.startsWith('/')) return fail(`${field}.path`, 'must start with "/"')
    const url = e.url === undefined ? undefined : https(`${field}.url`, e.url)
    if (url && e.path.endsWith('/') && !url.endsWith('/')) fail(`${field}.url`, 'must end with "/" for a directory')
    return {
      path: e.path,
      ...url ? { url } : {},
      rels: e.rels === undefined ? [] : strings(`${field}.rels`, e.rels),
      properties: e.properties === undefined ? [] : strings(`${field}.properties`, e.properties),
      linkProperties: e.link_properties === undefined ? [] : strings(`${field}.link_properties`, e.link_properties),
    }
  })

  const hostMetaEndpoint = optionalHttps('host_meta_endpoint')
  const postEndpoint = optionalHttps('post_endpoint')
  const commentEndpoint = optionalHttps('comment_endpoint')
  return {
    domain,
    identityHosts,
    issuer,
    authorizationEndpoint: https('authorization_endpoint'),
    tokenEndpoint: https('token_endpoint'),
    revocationEndpoint: https('revocation_endpoint'),
    storageBase: base('storage_base'),
    publicBase: base('public_base'),
    scopesSupported: strings('scopes_supported', raw.scopes_supported),
    wellKnownPaths,
    ...hostMetaEndpoint ? { hostMetaEndpoint } : {},
    ...postEndpoint ? { postEndpoint } : {},
    ...commentEndpoint ? { commentEndpoint } : {},
    maxUploadBytes: maxUploadBytes as number,
    specVersion,
    raw,
  }
}
