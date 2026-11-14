import { PupsError } from './errors.js'
import type { PupsServer } from './discovery.js'
import { scopeCovers } from './paths.js'

/**
 * A scope an app can request (RFC-6 "Scopes"):
 * - `'identify'`: sign-in only; the session can't write.
 * - `'appdata'`: shorthand for `write:/appdata/<client-host>/`, the app's own directory.
 * - `` `write:/${string}` ``: a well-known path declared by the server, or a file or directory inside a declared directory.
 */
export type Scope = 'identify' | 'appdata' | `write:/${string}`

/** The host of the `client_id`, which names the app's own directory. */
export const clientHostOf = (clientId: string) => new URL(clientId).hostname

/** The app's own directory, `/appdata/<client-host>/`. */
export const appDataPathOf = (clientId: string) => `/appdata/${clientHostOf(clientId)}/`

/** Expands `'appdata'` and removes duplicates. */
export function expandScopes(scopes: readonly Scope[], clientId: string): string[] {
  const expanded = scopes.map(s => s == 'appdata' ? `write:${appDataPathOf(clientId)}` : s)
  return [...new Set(expanded)]
}

const scopePathSyntax = /^\/(?:[A-Za-z0-9\-._~/]|%[0-9A-Fa-f]{2})*$/

/** The decoded path of a `write:` scope, or undefined for other scopes and malformed ones. */
export function writeScopePath(scope: string): string | undefined {
  if (!scope.startsWith('write:')) return
  const encoded = scope.slice('write:'.length)
  if (!scopePathSyntax.test(encoded)) return
  try {
    return decodeURIComponent(encoded)
  } catch {
    return
  }
}

/** The decoded paths of all `write:` scopes in a granted scope list. */
export const writeScopePaths = (scopes: readonly string[]) =>
  scopes.map(writeScopePath).filter((p): p is string => p !== undefined)

/**
 * Checks requested scopes against the server before the redirect, so that problems surface immediately instead of
 * as an OAuth error after a round trip. Only two kinds of write scope exist: the app's own directory, and declared
 * well-known paths (or paths inside declared directories).
 * @throws {PupsError} `invalid_scope`
 */
export function validateScopes(scopes: readonly string[], server: PupsServer, clientId: string): void {
  if (!scopes.length) throw new PupsError('invalid_scope', 'Request at least one scope.')
  const appDataPath = appDataPathOf(clientId)
  for (const scope of scopes) {
    if (scope == 'identify') continue
    const path = writeScopePath(scope)
    if (path === undefined)
      throw new PupsError('invalid_scope', `"${scope}" is not a PUPS scope. Use 'identify', 'appdata' or 'write:/<path>' (RFC-6, Scopes).`)
    if (path == appDataPath) continue
    if (path.startsWith('/appdata/'))
      throw new PupsError('invalid_scope', `"${scope}": an app may only ask for its own directory, ${appDataPath}. Use the 'appdata' shorthand (RFC-6, Scopes).`)
    const declared = server.wellKnownPaths.some(w => w.path == path || (w.path.endsWith('/') && path.startsWith(w.path)))
    if (!declared)
      throw new PupsError('invalid_scope', `"${scope}": ${path} is not a well-known path declared by ${new URL(server.domain).host}. Check server.wellKnownPaths before asking (RFC-6, Well-known paths).`)
  }
}

/** Whether the granted scopes allow writing the absolute path `path`. */
export const scopesCoverPath = (scopes: readonly string[], path: string) =>
  writeScopePaths(scopes).some(scopePath => scopeCovers(scopePath, path))
