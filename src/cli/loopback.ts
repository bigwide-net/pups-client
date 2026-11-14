import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PupsClient } from '../client.js'
import { PupsError } from '../errors.js'
import type { Scope } from '../scopes.js'
import type { PupsSession } from '../session.js'
import type { TokenStore } from '../store/token-store.js'

/** The path of the loopback redirect URI. The client metadata document lists `http://127.0.0.1/callback`. */
export const CALLBACK_PATH = '/callback'

export interface LoopbackLoginOptions {
  clientId: string
  /** The domain of the PUPS server owner, e.g. `tim.example.com`. */
  domain: string
  scopes: Scope[]
  store: TokenStore
  /** Opens the authorization URL. Default: the system browser. */
  openBrowser?: (url: string) => Promise<void> | void
  /** Called with the URL before opening it, e.g. to print it. */
  onUrl?: (url: string) => void
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * Signs in like a native app (RFC 8252, RFC-6 "Client identity"): listens on a random port of 127.0.0.1, opens
 * the authorization URL in the system browser, and receives the redirect at `http://127.0.0.1:<port>/callback`.
 * RFC-6 ignores the port of loopback redirect URIs, so the client metadata document lists
 * `http://127.0.0.1/callback` once.
 */
export async function loopbackLogin(options: LoopbackLoginOptions): Promise<PupsSession> {
  let onCallback: (request: IncomingMessage, response: ServerResponse) => void = (_, response) => {
    response.writeHead(404).end()
  }
  const server = createServer((request, response) => onCallback(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const client = new PupsClient({
    clientId: options.clientId,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    store: options.store,
    ...options.fetch ? { fetch: options.fetch } : {},
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const pending = await client.createAuthorization(options.domain, { scopes: options.scopes })
    const session = new Promise<PupsSession>((resolve, reject) => {
      timer = setTimeout(() => reject(new PupsError('authorization_failed', 'The login was not completed within 5 minutes.')), options.timeoutMs ?? 5 * 60_000)
      onCallback = (request, response) => {
        const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
        // Ignore everything that isn't our redirect, e.g. a browser asking for /favicon.ico.
        if (url.pathname != CALLBACK_PATH || url.searchParams.get('state') != pending.state) return void response.writeHead(404).end()
        client.completeAuthorization(url.href, pending).then(
          result => {
            page(response, 200, 'Signed in', `Signed in as ${result.session!.me}. You can close this tab and return to the terminal.`)
            resolve(result.session!)
          },
          (e: Error) => {
            page(response, 400, 'Login failed', `${e.message} You can close this tab.`)
            reject(e)
          },
        )
      }
    })
    options.onUrl?.(pending.url)
    await (options.openBrowser ?? openInBrowser)(pending.url)
    return await session
  } finally {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
}

/** A minimal page without scripts or external resources, so the code in the URL can't leak. */
function page(response: ServerResponse, status: number, title: string, message: string) {
  const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  })
  response.end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="font:16px system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em"><h1>${escape(title)}</h1><p>${escape(message)}</p></body>`)
}

/** Opens a URL in the system browser. Failures are ignored; the caller prints the URL as well. */
export function openInBrowser(url: string): void {
  const [command, args] = process.platform == 'darwin' ? ['open', [url]]
    : process.platform == 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]]
  try {
    spawn(command, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    // No browser available; the URL was printed.
  }
}
