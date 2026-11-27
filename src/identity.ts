import type { PupsServer } from './discovery.js'
import { PupsError, type PupsErrorCode } from './errors.js'
import { fetchWithTimeout, isObject, parseUrl } from './util.js'

/** The scope that lets an app get identity tokens (RFC-10). */
export const IDENTITY_SCOPE = 'identity-tokens'
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'
export const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt'

/** The scope of a read token (RFC-10 "Read tokens"). */
export const READ_SCOPE = 'read'
/** The longest lifetime RFC-10 allows: 300 seconds for a token for an action, 24 hours for a read token. */
const maxLifetime = { action: 300, read: 86_400 }

const exchangeTimeoutMs = 10_000

/**
 * Checks that `audience` is one `https` origin as the URL parser writes it, e.g. `https://polls.example.com`, without
 * path, `/`, query or fragment (RFC-10 "Token exchange"). The server checks the rest, e.g. that it is no IP address.
 * @throws {PupsError} `invalid_target`
 */
export function checkAudience(audience: string): void {
  const url = parseUrl(audience)
  if (url?.protocol != 'https:' || url.origin != audience)
    throw new PupsError('invalid_target', `"${audience}" is not an audience for an identity token: it must be one https origin${url?.protocol == 'https:' ? `, here ${url.origin}` : ', such as https://polls.example.com'}, without path or "/" (RFC-10).`)
}

/**
 * The outcome of a token exchange: the token with its lifetime in seconds, or that the server rejected the access
 * token (`invalid_grant`).
 */
export type ExchangeResult = { token: string; expiresIn: number } | { invalidGrant: true }

/**
 * Exchanges an access token for an identity token at the token endpoint (RFC 8693, RFC-10 "Token exchange"), with
 * `read` for a read token (`scope=read`).
 * @throws {PupsError} `insufficient_scope`, `invalid_target`, `rate_limited`, `unsupported`, `invalid_request`,
 *   `server_error`, `network`, `aborted`
 */
export async function exchangeToken(
  fetchFn: typeof fetch,
  server: PupsServer,
  clientId: string,
  accessToken: string,
  audience: string,
  read: boolean,
  signal?: AbortSignal,
): Promise<ExchangeResult> {
  const response = await fetchWithTimeout(fetchFn, server.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      client_id: clientId,
      subject_token: accessToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      audience,
      ...read ? { scope: READ_SCOPE } : {},
    }).toString(),
    credentials: 'omit',
    cache: 'no-store',
  }, exchangeTimeoutMs, signal)
  let json: Record<string, unknown> = {}
  try {
    json = await response.json()
  } catch {
    // Handled below by status.
  }
  const status = response.status
  if (response.ok) {
    const { access_token, issued_token_type, expires_in, scope } = json
    if (typeof access_token != 'string' || !access_token || (issued_token_type !== undefined && issued_token_type != JWT_TOKEN_TYPE))
      throw new PupsError('server_error', 'The token endpoint answered the token exchange without an identity token.', { status })
    if (read && scope != READ_SCOPE)
      throw new PupsError('unsupported', `${server.issuer} answered with a token for an action instead of a read token: it doesn't issue read tokens (RFC-10, Read tokens).`, { status })
    // The lifetime is the server's choice (RFC-10); without one, assume the shortest that makes sense.
    const max = read ? maxLifetime.read : maxLifetime.action
    return { token: access_token, expiresIn: typeof expires_in == 'number' && expires_in > 0 ? Math.min(expires_in, max) : 60 }
  }
  const error = typeof json.error == 'string' ? json.error : undefined
  const serverMessage = typeof json.error_description == 'string' ? json.error_description : undefined
  const detail = `${error ?? `HTTP ${status}`}${serverMessage ? `: ${serverMessage}` : ''}`
  const fail = (code: PupsErrorCode, message: string, retryAfter?: number) =>
    new PupsError(code, `${message} (${detail}).`, { status, serverMessage, retryAfter })
  if (error == 'invalid_grant') return { invalidGrant: true }
  if (status == 429) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw fail('rate_limited', 'Too many identity tokens for this grant; try again later', retryAfter > 0 ? retryAfter : undefined)
  }
  if (status >= 500) throw fail('server_error', 'The token exchange failed')
  if (error == 'invalid_scope') throw fail('insufficient_scope', `The grant has no ${IDENTITY_SCOPE} scope${read ? ', or the server issues no read tokens' : ''}. Log in again and ask for it`)
  if (error == 'invalid_target') throw fail('invalid_target', `${server.issuer} issues no identity token for ${audience}`)
  if (error == 'unsupported_grant_type') throw fail('unsupported', `${server.issuer} doesn't support token exchange`)
  throw fail('invalid_request', 'The token exchange failed')
}

/**
 * The parameters of the first `Bearer` challenge in a `WWW-Authenticate` header (RFC 6750, RFC 9110), with lowercase
 * names and unquoted values, e.g. `{ realm: 'Moderation queue', identity: 'required' }`; undefined without one.
 */
export function bearerChallenge(header: string | null | undefined): Record<string, string> | undefined {
  if (!header) return
  const item = /[\s,]*([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|[A-Za-z0-9!#$%&'*+.^_`|~\/:-]+))?/y
  let params: Record<string, string> | undefined
  let found: Record<string, string> | undefined
  for (let i = 0; i < header.length;) {
    item.lastIndex = i
    const m = item.exec(header)
    // Skip what isn't a token, e.g. the "=" padding of a token68.
    if (!m) {
      i++
      continue
    }
    i = item.lastIndex
    const [, name, value] = m
    if (value === undefined) {
      // A scheme starts the next challenge.
      if (found) break
      params = name!.toLowerCase() == 'bearer' ? found = {} : undefined
    } else if (params)
      params[name!.toLowerCase()] = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value
  }
  return found
}

/** What a feed's server says about identity tokens (RFC-10 "The server's challenge"). */
export interface IdentityChallenge {
  /**
   * `required` (on a `401`): the feed is `restricted` or `personal` and needs an identity token. `optional` (on a
   * `200`): a token would give a personal version. Undefined if the server doesn't say.
   */
  identity?: 'required' | 'optional'
  /** The challenge's `realm`, which may name the feed. The server's words: show them as such. */
  realm?: string
  /** The challenge's `error`, e.g. `invalid_token` or `insufficient_scope`. */
  error?: string
  /** `title` of an `application/problem+json` body (RFC 9457). The server's words. */
  title?: string
  /** `detail` of an `application/problem+json` body, e.g. "Ask the admin of comments.example.org to add you". */
  detail?: string
}

/**
 * Reads the Bearer challenge (`identity`, `realm`, `error`) and the `application/problem+json` body of a response,
 * e.g. of a fetch of a feed without a token (RFC-10 "The server's challenge"). The body is read from a clone, so the
 * response stays usable. Use it to make an offer such as *Subscribe as @tim.example.com*, never to fetch with a token
 * on its own: only the user decides that. In browsers, the server must expose `WWW-Authenticate` with
 * `Access-Control-Expose-Headers`.
 * @returns undefined if the response has neither.
 */
export async function identityChallenge(response: Response): Promise<IdentityChallenge | undefined> {
  const bearer = bearerChallenge(response.headers.get('WWW-Authenticate'))
  let problem: Record<string, unknown> = {}
  if (/^application\/problem\+json\b/i.test(response.headers.get('Content-Type') ?? '') && !response.bodyUsed)
    try {
      const json: unknown = await response.clone().json()
      if (isObject(json)) problem = json
    } catch {
      // No usable body.
    }
  const text = (value: unknown) => typeof value == 'string' && value ? value : undefined
  const identity = bearer?.identity == 'required' || bearer?.identity == 'optional' ? bearer.identity : undefined
  const challenge: IdentityChallenge = {
    ...identity ? { identity } : {},
    ...text(bearer?.realm) ? { realm: bearer!.realm } : {},
    ...text(bearer?.error) ? { error: bearer!.error } : {},
    ...text(problem.title) ? { title: problem.title as string } : {},
    ...text(problem.detail) ? { detail: problem.detail as string } : {},
  }
  return bearer || Object.keys(challenge).length ? challenge : undefined
}
