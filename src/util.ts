import { PupsError } from './errors.js'

/** Base64url without padding (RFC 4648 §5), as PKCE requires. */
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `length` bytes from the cryptographically secure generator, base64url-encoded. */
export const randomString = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length)))

export async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return base64url(new Uint8Array(digest))
}

/** Resolves after `ms` milliseconds, or rejects with `aborted` when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const abortError = () => new PupsError('aborted', 'The operation was aborted.')

/**
 * `fetch` with a timeout and an optional caller signal. Network failures become `network` errors,
 * the caller's abort becomes `aborted`. HTTP error statuses are returned, not thrown.
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw abortError()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetchFn(url, { ...init, signal: controller.signal })
  } catch (e) {
    if (signal?.aborted) throw abortError()
    const host = new URL(url).host
    throw new PupsError('network', timedOut
      ? `No response from ${host} within ${timeoutMs / 1000} seconds.`
      : `Could not reach ${host}: ${networkProblem(e)}`,
    { cause: e })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

const networkProblems: Record<string, string> = {
  ENOTFOUND: 'the domain name doesn\'t exist. Check the spelling.',
  EAI_AGAIN: 'the domain name can\'t be looked up right now. Check the connection and the spelling.',
  ECONNREFUSED: 'the server refused the connection. Is it running, and does it accept HTTPS on port 443?',
  ECONNRESET: 'the connection was reset.',
  ETIMEDOUT: 'the connection timed out.',
  EHOSTUNREACH: 'the host is unreachable.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its TLS certificate is self-signed and not trusted.',
  SELF_SIGNED_CERT_IN_CHAIN: 'its TLS certificate chain contains an untrusted self-signed certificate.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its TLS certificate can\'t be verified.',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the issuer of its TLS certificate is not trusted.',
  CERT_HAS_EXPIRED: 'its TLS certificate has expired.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its TLS certificate is for another domain.',
}

/**
 * Explains a failed `fetch`. Node puts the reason (`ENOTFOUND`, certificate errors, …) in `cause.code`; browsers
 * hide it, and there a missing CORS header is a common cause.
 */
function networkProblem(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause
  const known = cause?.code && networkProblems[cause.code]
  if (known) return known
  if (cause?.code) return `${cause.code}${cause.message ? ` (${cause.message})` : ''}.`
  return typeof window == 'undefined'
    ? `${(e as Error)?.message ?? 'the request failed'}.`
    : 'check the connection and the spelling of the domain, and that the server sends CORS headers.'
}

/** Parses `value` as a URL, or returns undefined. */
export function parseUrl(value: unknown): URL | undefined {
  if (typeof value != 'string') return
  try {
    return new URL(value)
  } catch {
    return
  }
}

/** Whether `host` is `clientHost`, optionally with or without a leading `www.` (RFC-6 "Client identity"). */
export const isSameHostOrWww = (host: string, clientHost: string) =>
  host == clientHost || host == `www.${clientHost}` || `www.${host}` == clientHost

/** The loopback hosts RFC-6 accepts in redirect URIs. `localhost` is deliberately not one of them. */
export const isLoopbackHost = (hostname: string) => hostname == '127.0.0.1' || hostname == '[::1]'

/** Control characters: C0, DEL and C1. */
export const controlChars = /[\u0000-\u001f\u007f-\u009f]/
