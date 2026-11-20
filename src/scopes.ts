import { PupsError } from './errors.js'
import type { PupsServer } from './discovery.js'
import { isPrivate, scopeCovers } from './paths.js'

/**
 * A scope an app can request (RFC-6 "Scopes"):
 * - `'identify'`: sign-in only; the session can't write.
 * - `'appdata'`: shorthand for `write:/appdata/<client-host>/`, the app's own directory, including its private
 *   folder `private/`.
 * - `` `write:/${string}` ``: a well-known path declared by the server, or a file or directory inside a declared directory.
 *   In `/pups/private/`, it also allows reading.
 * - `` `read:/${string}` ``: reading a private path in `/pups/private/` that the server declares, without writing it.
 *   Public files need no read scope.
 */
export type Scope = 'identify' | 'appdata' | `write:/${string}` | `read:/${string}`

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

/** The decoded path of a `<kind>:` scope, or undefined for other scopes and malformed ones. */
function scopePath(scope: string, kind: 'write' | 'read'): string | undefined {
  if (!scope.startsWith(`${kind}:`)) return
  const encoded = scope.slice(kind.length + 1)
  if (!scopePathSyntax.test(encoded)) return
  try {
    return decodeURIComponent(encoded)
  } catch {
    return
  }
}

/** The decoded path of a `write:` scope, or undefined for other scopes and malformed ones. */
export const writeScopePath = (scope: string) => scopePath(scope, 'write')

/** The decoded path of a `read:` scope, or undefined for other scopes and malformed ones. */
export const readScopePath = (scope: string) => scopePath(scope, 'read')

/** The decoded paths of all `write:` scopes in a granted scope list. */
export const writeScopePaths = (scopes: readonly string[]) =>
  scopes.map(writeScopePath).filter((p): p is string => p !== undefined)

/** The decoded paths of the scopes that allow reading private files: every `write:` and every `read:` scope. */
export const readScopePaths = (scopes: readonly string[]) =>
  [...writeScopePaths(scopes), ...scopes.map(readScopePath).filter((p): p is string => p !== undefined)]

/**
 * Checks requested scopes against the server before the redirect, so that problems surface immediately instead of
 * as an OAuth error after a round trip. Only two kinds of write scope exist: the app's own directory, and declared
 * well-known paths (or paths inside declared directories). Read scopes exist only for declared paths in
 * `/pups/private/`.
 * @throws {PupsError} `invalid_scope`
 */
export function validateScopes(scopes: readonly string[], server: PupsServer, clientId: string): void {
  if (!scopes.length) throw new PupsError('invalid_scope', 'Request at least one scope.')
  const appDataPath = appDataPathOf(clientId)
  for (const scope of scopes) {
    if (scope == 'identify') continue
    const read = readScopePath(scope)
    if (read !== undefined && !read.startsWith('/pups/private/'))
      throw new PupsError('invalid_scope', `"${scope}": read scopes exist only for private paths in /pups/private/. Public files need no read scope, and an app's own private folder is covered by 'appdata' (RFC-6, Scopes).`)
    const path = read ?? writeScopePath(scope)
    if (path === undefined)
      throw new PupsError('invalid_scope', `"${scope}" is not a PUPS scope. Use 'identify', 'appdata', 'write:/<path>' or 'read:/pups/private/<path>' (RFC-6, Scopes).`)
    if (path == appDataPath && read === undefined) continue
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

/** Whether the granted scopes allow reading the absolute path `path`: always for public files, by scope for private ones. */
export const scopesAllowReading = (scopes: readonly string[], path: string) =>
  !isPrivate(path) || readScopePaths(scopes).some(scopePath => scopeCovers(scopePath, path))
