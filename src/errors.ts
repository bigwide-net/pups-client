/**
 * Error codes of {@link PupsError}.
 *
 * Codes of the upload API are the `error` values of RFC-6 ("Errors"), so apps can switch on them directly.
 * Problems the library detects before sending a request use the same codes the server would answer with.
 */
export type PupsErrorCode =
  // Discovery
  /** The domain the user typed can't be turned into `https://<host>/`. */
  | 'invalid_domain'
  /** The domain has no `host-meta.json` with a PUPS link, or it can't be fetched. */
  | 'no_pups_server'
  /** The configuration document is missing required fields or has invalid values. */
  | 'invalid_server_config'
  /** The server implements a `spec_version` this library doesn't support. */
  | 'unsupported_server_version'
  // Authorization
  /** A requested scope is not allowed by the server or for this client. */
  | 'invalid_scope'
  /** The owner denied the request, or dropped every scope. */
  | 'access_denied'
  /** The authorization response doesn't belong to a request started by this app in this browser. */
  | 'state_mismatch'
  /** The `iss` of the authorization response is not the discovered issuer (mix-up defence, RFC 9207). */
  | 'issuer_mismatch'
  /** The `me` of the token response is not the domain the user entered, and doesn't lead to the same issuer. */
  | 'identity_mismatch'
  /** The browser blocked the login popup. Fall back to `login()`. */
  | 'popup_blocked'
  /** The popup flow didn't finish in time. */
  | 'popup_timeout'
  /** Any other failure of the authorization or the code exchange. */
  | 'authorization_failed'
  // Session
  /** The session ended: the grant was revoked, the refresh token expired, or the user logged out. Log in again. */
  | 'session_expired'
  // Upload API (RFC-6 "Errors") and host-meta endpoint
  | 'invalid_path'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'not_found'
  | 'precondition_failed'
  | 'too_large'
  | 'unsupported_type'
  | 'insufficient_storage'
  // Feeds (RFC-7)
  /** A feed file or archive has no `_pups.pupsControlled` marker: it is maintained by other means and never written. */
  | 'not_pups_controlled'
  /** A feed file or archive is not a JSON Feed. */
  | 'invalid_feed'
  /** `409` from the host-meta endpoint: a single-valued rel is taken, or `host-meta.json` is not valid JSON. */
  | 'conflict'
  /** `429`: the server limits the write rate of this grant. See {@link PupsError.retryAfter}. */
  | 'rate_limited'
  /** `400` for a reason other than the path, or an argument the library can't send. */
  | 'invalid_request'
  // Identity tokens (RFC-10)
  /** The audience of an identity token is not one `https` origin that the PUPS server issues tokens for. */
  | 'invalid_target'
  // Other
  /** The server doesn't offer the feature, e.g. no `host_meta_endpoint`, or no identity tokens. */
  | 'unsupported'
  /** The request couldn't be sent, or timed out. */
  | 'network'
  /** The caller aborted the operation with an `AbortSignal`. */
  | 'aborted'
  /** The server answered with an unexpected status, usually `5xx`. */
  | 'server_error'

const retryableCodes = new Set<PupsErrorCode>(['network', 'rate_limited', 'server_error'])

export interface PupsErrorOptions {
  status?: number
  serverMessage?: string
  retryAfter?: number
  cause?: unknown
}

/** The only error type thrown by pups-client. */
export class PupsError extends Error {
  override readonly name = 'PupsError'
  /** What went wrong, see {@link PupsErrorCode}. */
  readonly code: PupsErrorCode
  /** The HTTP status, if a response caused the error. */
  readonly status?: number
  /** The `message` (or OAuth `error_description`) from the server's error body, if any. Not localized. */
  readonly serverMessage?: string
  /** Seconds to wait before retrying, from a `Retry-After` header. */
  readonly retryAfter?: number
  /** Whether repeating the same call later may succeed: network problems, `429` and `5xx` (except `507`). */
  readonly retryable: boolean

  constructor(code: PupsErrorCode, message: string, options: PupsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.status = options.status
    this.serverMessage = options.serverMessage
    this.retryAfter = options.retryAfter
    this.retryable = retryableCodes.has(code)
  }
}

/** Whether `e` is a {@link PupsError}, optionally with one of the given codes. */
export const isPupsError = (e: unknown, ...codes: PupsErrorCode[]): e is PupsError =>
  e instanceof PupsError && (!codes.length || codes.includes(e.code))

const statusCodes: Record<number, PupsErrorCode> = {
  401: 'invalid_token',
  403: 'insufficient_scope',
  404: 'not_found',
  409: 'conflict',
  412: 'precondition_failed',
  413: 'too_large',
  415: 'unsupported_type',
  429: 'rate_limited',
  507: 'insufficient_storage',
}

/** Turns an error response of the upload API or the host-meta endpoint into a {@link PupsError} (RFC-6 "Errors"). */
export async function errorFromResponse(response: Response, what: string): Promise<PupsError> {
  let body: { error?: unknown; message?: unknown } = {}
  try {
    body = await response.json()
  } catch {
    // Not every error comes from PUPS itself (proxies, WAFs), so a missing JSON body is normal.
  }
  const status = response.status
  const serverError = typeof body.error == 'string' ? body.error : undefined
  const serverMessage = typeof body.message == 'string' ? body.message : undefined
  const code: PupsErrorCode = status == 400
    ? serverError == 'invalid_path' ? 'invalid_path' : 'invalid_request'
    : serverError == 'not_pups_controlled' ? serverError : statusCodes[status] ?? 'server_error'
  const retryAfterHeader = Number(response.headers.get('Retry-After'))
  return new PupsError(code, `${what} failed with HTTP ${status}${serverMessage ? `: ${serverMessage}` : ''}`, {
    status,
    serverMessage,
    retryAfter: retryAfterHeader > 0 ? retryAfterHeader : undefined,
  })
}
