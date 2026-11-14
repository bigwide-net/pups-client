import { discover, normalizeDomain, type PupsServer } from './discovery.js'
import { PupsError } from './errors.js'
import { fetchWithTimeout, parseUrl, randomString, sha256Base64url } from './util.js'

const tokenTimeoutMs = 10_000

/** PKCE (RFC 7636) with S256, the only method RFC-6 accepts. */
export async function createPkce() {
  // 48 random bytes give a 64-character verifier, within the 43–128 RFC 7636 allows.
  const verifier = randomString(48)
  return { verifier, challenge: await sha256Base64url(verifier) }
}

export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  state: string
  codeChallenge: string
}

/** The URL of the authorization endpoint for a request (RFC-6 "Authorization", "Request"). */
export function authorizationUrl(server: PupsServer, request: AuthorizationRequest): string {
  const url = new URL(server.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', request.clientId)
  url.searchParams.set('redirect_uri', request.redirectUri)
  url.searchParams.set('scope', request.scopes.join(' '))
  url.searchParams.set('state', request.state)
  url.searchParams.set('code_challenge', request.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.href
}

/** The parameters of an authorization response. */
export interface CallbackParams {
  state: string
  code?: string
  iss?: string
  error?: string
  errorDescription?: string
}

/** The query parameters an authorization response may carry; removed from the address bar after reading. */
export const callbackParamNames = ['code', 'state', 'iss', 'error', 'error_description', 'error_uri']

/**
 * Reads an authorization response from a URL. Returns undefined unless the URL carries a `state` created by this
 * library (prefixed `r.` or `p.`) together with `code` or `error`, so apps can call it on every page load.
 */
export function parseCallback(url: string): CallbackParams | undefined {
  const params = parseUrl(url)?.searchParams
  const state = params?.get('state')
  if (!params || !state || !/^[rp]\./.test(state) || (!params.has('code') && !params.has('error'))) return
  const get = (name: string) => params.get(name) ?? undefined
  return { state, code: get('code'), iss: get('iss'), error: get('error'), errorDescription: get('error_description') }
}

/** A token response (RFC-6 "Tokens"). */
export interface TokenResponse {
  accessToken: string
  expiresIn: number
  refreshToken?: string
  /** The granted scopes; undefined if the server omitted `scope`. */
  scopes?: string[]
  me: string
}

function parseTokenResponse(json: Record<string, unknown>): TokenResponse {
  const { access_token, token_type, expires_in, refresh_token, scope, me } = json
  if (typeof access_token != 'string' || !access_token || typeof token_type != 'string' || token_type.toLowerCase() != 'bearer')
    throw new PupsError('authorization_failed', 'The token response has no bearer access token.')
  if (typeof me != 'string') throw new PupsError('authorization_failed', 'The token response has no "me".')
  return {
    accessToken: access_token,
    expiresIn: typeof expires_in == 'number' && expires_in > 0 ? expires_in : 3600,
    refreshToken: typeof refresh_token == 'string' && refresh_token ? refresh_token : undefined,
    scopes: typeof scope == 'string' ? scope.split(' ').filter(Boolean) : undefined,
    me,
  }
}

/**
 * Sends a request to the token endpoint. Failures are mapped for the caller's situation:
 * for a code exchange every OAuth error is `authorization_failed`; for a refresh, `invalid_grant` and other
 * `4xx` answers end the session (`session_expired`), while network problems, `429` and `5xx` stay retryable.
 */
export async function tokenRequest(
  fetchFn: typeof fetch,
  server: PupsServer,
  params: Record<string, string>,
  kind: 'code' | 'refresh',
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(fetchFn, server.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    credentials: 'omit',
    cache: 'no-store',
  }, tokenTimeoutMs, signal)
  let json: Record<string, unknown> = {}
  try {
    json = await response.json()
  } catch {
    // Handled below by status.
  }
  if (response.ok) return parseTokenResponse(json)
  const status = response.status
  const error = typeof json.error == 'string' ? json.error : undefined
  const serverMessage = typeof json.error_description == 'string' ? json.error_description : undefined
  const detail = `${error ?? `HTTP ${status}`}${serverMessage ? `: ${serverMessage}` : ''}`
  if (status == 429 || status >= 500)
    throw new PupsError(status == 429 ? 'rate_limited' : 'server_error', `The token endpoint failed (${detail}).`, { status, serverMessage })
  throw kind == 'refresh'
    ? new PupsError('session_expired', `The session can't be renewed (${detail}). Log in again.`, { status, serverMessage })
    : new PupsError('authorization_failed', `The code exchange failed (${detail}).`, { status, serverMessage })
}

/** Revokes a token (RFC 7009). Returns whether the server confirmed it; never throws. */
export async function revokeToken(
  fetchFn: typeof fetch,
  server: PupsServer,
  clientId: string,
  token: string,
  hint: 'access_token' | 'refresh_token',
): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(fetchFn, server.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: clientId }).toString(),
      credentials: 'omit',
      cache: 'no-store',
    }, tokenTimeoutMs)
    return response.ok
  } catch {
    return false
  }
}

/**
 * Verifies `me` from a token response (RFC-6 "What apps must do", step 2) and returns it normalized.
 * `me` must name one of the server's identity hosts; otherwise discovery on `me` must lead to the same issuer.
 * @throws {PupsError} `identity_mismatch`
 */
export async function verifyMe(fetchFn: typeof fetch, me: string, server: PupsServer): Promise<string> {
  const mismatch = (why: string) => new PupsError('identity_mismatch', `The server named "${me}" as the user's identity, but ${why}.`)
  const url = parseUrl(me)
  if (!url || url.protocol != 'https:' || url.pathname != '/' || url.search || url.hash || url.port)
    throw mismatch('that is not of the form https://<host>/')
  const normalized = normalizeDomain(me)
  const host = new URL(normalized).hostname
  if (server.identityHosts.includes(host)) return normalized
  let other: PupsServer
  try {
    other = await discover(normalized, fetchFn)
  } catch (e) {
    throw mismatch(`discovery on it failed: ${(e as Error).message}`)
  }
  if (other.issuer != server.issuer) throw mismatch(`it leads to another issuer (${other.issuer}, not ${server.issuer})`)
  return normalized
}
