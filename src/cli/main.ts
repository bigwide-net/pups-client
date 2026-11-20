import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { PupsClient } from '../client.js'
import { normalizeDomain } from '../discovery.js'
import { isPupsError, PupsError } from '../errors.js'
import type { Scope } from '../scopes.js'
import type { PupsSession } from '../session.js'
import { VERSION } from '../version.js'
import { FileTokenStore } from './file-store.js'
import { CALLBACK_PATH, loopbackLogin, openInBrowser } from './loopback.js'

/** Where the client metadata document lives when only the client's domain is given. */
export const DEFAULT_CLIENT_DOCUMENT = 'pups-cli.json'

const help = `pups ${VERSION}: upload files to your own domain with a Personal Upload Server (PUPS).

Usage: pups <command> [options]

Getting started:
  pups client-metadata <client>        Print the client metadata document to publish on <client>
  pups check-client <client>           Check the published client metadata document
  pups login <domain> -c <client>      Sign in at the PUPS server of <domain> as its owner

Working with files (paths without leading "/" are in the app's own directory):
  pups whoami                          Show the signed-in identity and the granted scopes
  pups put <file>... [--to <path>]     Upload files ("-" reads stdin; needs --to)
  pups get <path> [-o <file>]          Download a file (to stdout by default)
  pups rm <path>...                    Delete files
  pups url <path>                      Print the public URL of a path
  pups link add|remove <rel> <path>    Add or remove a host-meta.json link to one of your files
  pups property set <uri> <value>      Set a host-meta.json property
  pups logout [--keep-grant]           Forget the credentials and revoke the grant
  pups sessions                        List stored sessions

Options:
  -c, --client <domain|url>  The client app: its domain (document at https://<domain>/${DEFAULT_CLIENT_DOCUMENT})
                             or the URL of its client metadata document. Env: PUPS_CLIENT
  -d, --domain <domain>      Which signed-in domain to use. Default: the most recent. Env: PUPS_DOMAIN
  -s, --scope <scope>        login: scope to request, repeatable: appdata (default), identify,
                             write:/<well-known path>, read:/pups/private/<private path>
      --no-browser           login: print the URL instead of opening the browser
      --skip-check           login: don't check the client metadata document first
      --to <path>            put: target path, or directory ending in "/". Default: the file name
      --create               put: fail if the file already exists
      --if-match <etag>      put, rm: only if the file is unchanged since this ETag
      --content-type <type>  put: upload type, if not the default for the extension
  -o, --output <file>        get: write to a file
      --type <media type>    link add: the link's type
      --keep-grant           logout: only forget the credentials on this computer
      --json                 Machine-readable output (whoami, put, sessions)
  -h, --help                 Show this help
      --version              Show the version

Credentials are stored in ${storeFile().replace(homedir(), '~')} (readable only by you).
Don't run two pups commands for the same domain at the same time.`

class UsageError extends Error {}

function storeFile() {
  const base = process.env.PUPS_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'pups')
  return join(base, 'sessions.json')
}

/** `tim.example.app` → `https://tim.example.app/pups-cli.json`; a full URL stays as it is. */
export function clientIdFor(client: string): string {
  if (/^https?:\/\//i.test(client)) return client
  return normalizeDomain(client) + DEFAULT_CLIENT_DOCUMENT
}

/** The client metadata document the CLI needs, for publishing at `clientId`. */
export function cliClientMetadata(clientId: string) {
  const url = new URL(clientId)
  return {
    client_id: clientId,
    client_name: `PUPS command line (${url.hostname})`,
    client_uri: `${url.origin}/`,
    redirect_uris: [`http://127.0.0.1${CALLBACK_PATH}`, `http://[::1]${CALLBACK_PATH}`],
  }
}

const parseScope = (scope: string): Scope => {
  if (scope == 'identify' || scope == 'appdata' || scope.startsWith('write:/') || scope.startsWith('read:/')) return scope as Scope
  throw new UsageError(`Unknown scope "${scope}". Use appdata, identify, write:/<path> or read:/pups/private/<path>.`)
}

const out = (text: string) => process.stdout.write(text + '\n')
const info = (text: string) => process.stderr.write(text + '\n')

/** Runs the CLI with `argv` (without `node` and the script) and returns the exit code: 0 ok, 1 error, 2 usage. */
export function main(argv: string[]): Promise<number> {
  return run(argv).catch(reportError)
}

async function run(argv: string[]): Promise<number> {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      client: { type: 'string', short: 'c' },
      domain: { type: 'string', short: 'd' },
      scope: { type: 'string', short: 's', multiple: true },
      'no-browser': { type: 'boolean' },
      'skip-check': { type: 'boolean' },
      to: { type: 'string' },
      create: { type: 'boolean' },
      'if-match': { type: 'string' },
      'content-type': { type: 'string' },
      output: { type: 'string', short: 'o' },
      type: { type: 'string' },
      'keep-grant': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  })
  if (opts.version) {
    out(VERSION)
    return 0
  }
  const [command, ...args] = positionals
  if (opts.help || !command) {
    out(help)
    return opts.help ? 0 : 2
  }

  const store = new FileTokenStore(storeFile())
  const client = opts.client ?? process.env.PUPS_CLIENT
  const domain = opts.domain ?? process.env.PUPS_DOMAIN
  const requireArgs = (count: number, usage: string) => {
    if (args.length < count) throw new UsageError(`Usage: pups ${usage}`)
  }

  /** The stored session to use: filtered by --client and --domain, the most recently used one. */
  const openSession = async (): Promise<PupsSession> => {
    let records = await store.listAll()
    if (client) records = records.filter(r => r.clientId == clientIdFor(client))
    if (domain) records = records.filter(r => r.me == normalizeDomain(domain))
    const record = records.sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]
    if (!record) throw new UsageError(`Not signed in${domain ? ` at ${domain}` : ''}. Run: pups login <domain> --client <client-domain>`)
    const pups = new PupsClient({ clientId: record.clientId, redirectUri: `http://127.0.0.1${CALLBACK_PATH}`, store })
    return (await pups.restore(record.me))!
  }

  switch (command) {
    case 'client-metadata': {
      const clientArg = args[0] ?? client
      if (!clientArg) throw new UsageError('Usage: pups client-metadata <client-domain>')
      const clientId = clientIdFor(clientArg)
      out(JSON.stringify(cliClientMetadata(clientId), null, 2))
      info(`\nPublish this document at ${clientId}, served over HTTPS as application/json.`)
      return 0
    }

    case 'check-client': {
      const clientArg = args[0] ?? client
      if (!clientArg) throw new UsageError('Usage: pups check-client <client-domain>')
      const problems = await checkClient(clientIdFor(clientArg))
      if (!problems.length) {
        out(`${clientIdFor(clientArg)} is fine.`)
        return 0
      }
      for (const problem of problems) info(`- ${problem}`)
      return 1
    }

    case 'login': {
      requireArgs(1, 'login <domain> --client <client-domain>')
      if (!client) throw new UsageError('Which app is signing in? Pass --client <client-domain> or set PUPS_CLIENT.')
      const clientId = clientIdFor(client)
      if (!opts['skip-check']) {
        const problems = await checkClient(clientId)
        if (problems.length) {
          info(`The client metadata document at ${clientId} has problems; the server would reject the login:`)
          for (const problem of problems) info(`- ${problem}`)
          info(`Print a valid document with: pups client-metadata ${client}`)
          return 1
        }
      }
      const scopes = (opts.scope ?? ['appdata']).map(parseScope)
      const session = await loopbackLogin({
        clientId,
        domain: args[0]!,
        scopes,
        store,
        onUrl: url => info(opts['no-browser']
          ? `Open this URL in a browser to sign in:\n\n  ${url}\n`
          : `Opening the browser to sign in. If it doesn't open, visit:\n\n  ${url}\n`),
        openBrowser: opts['no-browser'] ? () => {} : openInBrowser,
      })
      out(`Signed in as ${session.me}`)
      info(`Granted: ${session.scopes.join(' ')}`)
      const requested = scopes.map(s => s == 'appdata' ? `write:${session.appDataPath}` : s)
      const dropped = requested.filter(s => !session.scopes.includes(s))
      if (dropped.length) info(`Not granted: ${dropped.join(' ')}`)
      return 0
    }

    case 'whoami': {
      const session = await openSession()
      const data = {
        me: session.me,
        client: session.clientId,
        issuer: session.issuer,
        scopes: session.scopes,
        appData: session.appDataPath,
        publicBase: session.server.publicBase,
      }
      if (opts.json) out(JSON.stringify(data, null, 2))
      else for (const [key, value] of Object.entries(data)) out(`${key.padEnd(10)} ${Array.isArray(value) ? value.join(' ') : value}`)
      return 0
    }

    case 'put': {
      requireArgs(1, 'put <file>... [--to <path>]')
      const to = opts.to
      if (args.length > 1 && to && !to.endsWith('/')) throw new UsageError('--to must be a directory ending in "/" when uploading several files.')
      if (args.includes('-') && (!to || to.endsWith('/'))) throw new UsageError('Reading from stdin ("-") needs --to <path>.')
      const session = await openSession()
      const results = []
      for (const file of args) {
        const target = to ? to.endsWith('/') ? to + basename(file) : to : basename(file)
        const data = file == '-' ? await readStdin() : await readFile(file)
        const options = opts['content-type'] ? { contentType: opts['content-type'] } : {}
        const result = opts.create ? await session.create(target, data, options)
          : opts['if-match'] ? await session.replace(target, data, opts['if-match'], options)
          : await session.put(target, data, options)
        results.push(result)
        if (!opts.json) {
          out(result.url ?? `${result.path} (private, no public URL)`)
          info(`  ${result.created ? 'created' : 'replaced'} ${result.path} (ETag ${result.etag})`)
        }
      }
      if (opts.json) out(JSON.stringify(results, null, 2))
      return 0
    }

    case 'get': {
      requireArgs(1, 'get <path> [-o <file>]')
      const session = await openSession()
      const file = await session.get(args[0]!)
      if (!file) throw new PupsError('not_found', `${session.resolve(args[0]!)} doesn't exist.`)
      const bytes = new Uint8Array(await (await file.blob()).arrayBuffer())
      if (opts.output) {
        await writeFile(opts.output, bytes)
        info(`Saved ${file.path} to ${opts.output} (ETag ${file.etag})`)
      } else process.stdout.write(bytes)
      return 0
    }

    case 'rm': {
      requireArgs(1, 'rm <path>...')
      const session = await openSession()
      for (const path of args) {
        await session.delete(path, opts['if-match'] ? { ifMatch: opts['if-match'] } : {})
        info(`Deleted ${session.resolve(path)}`)
      }
      return 0
    }

    case 'url': {
      requireArgs(1, 'url <path>')
      const session = await openSession()
      for (const path of args) out(session.publicUrl(path))
      return 0
    }

    case 'link': {
      const [action, rel, path] = args
      if ((action != 'add' && action != 'remove') || !rel || !path) throw new UsageError('Usage: pups link add|remove <rel> <path> [--type <media type>]')
      const session = await openSession()
      if (action == 'add') await session.hostMeta.addLink({ rel, href: path, ...opts.type ? { type: opts.type } : {} })
      else await session.hostMeta.removeLink({ rel, href: path })
      info(`${action == 'add' ? 'Added' : 'Removed'} ${rel} → ${session.publicUrl(path)}`)
      return 0
    }

    case 'property': {
      const [action, uri, value] = args
      if (action != 'set' || !uri || value === undefined) throw new UsageError('Usage: pups property set <uri> <value>')
      const session = await openSession()
      await session.hostMeta.setProperty(uri, value)
      info(`Set ${uri}`)
      return 0
    }

    case 'logout': {
      const session = await openSession()
      const { revoked } = await session.logout({ revoke: !opts['keep-grant'] })
      out(`Signed out of ${session.me}`)
      if (!opts['keep-grant']) info(revoked ? 'The grant was revoked.' : 'The server did not confirm the revocation; remove the app on its apps page if needed.')
      return 0
    }

    case 'sessions': {
      const records = (await store.listAll()).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const data = records.map(r => ({ me: r.me, client: r.clientId, scopes: r.scopes, lastUsed: new Date(r.lastUsedAt).toISOString() }))
      if (opts.json) out(JSON.stringify(data, null, 2))
      else if (!data.length) info('No sessions. Run: pups login <domain> --client <client-domain>')
      else for (const s of data) out(`${s.me}  via ${s.client}  [${s.scopes.join(' ')}]  last used ${s.lastUsed}`)
      return 0
    }

    default:
      throw new UsageError(`Unknown command "${command}". Run pups --help.`)
  }
}

async function checkClient(clientId: string): Promise<string[]> {
  const pups = new PupsClient({ clientId, redirectUri: `http://127.0.0.1${CALLBACK_PATH}` })
  return (await pups.checkClientMetadata()).problems
}

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Prints an error the way a user can act on it, and returns the exit code. */
export function reportError(e: unknown): number {
  const usage = e instanceof UsageError || !!(e as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS')
  if (usage) info(`${(e as Error).message}${e instanceof UsageError ? '' : '. Run pups --help.'}`)
  else if (isPupsError(e, 'session_expired', 'invalid_token')) info(`${e.message}\nRun: pups login <domain> --client <client-domain>`)
  else if (e instanceof PupsError) info(`Error (${e.code}): ${e.message}`)
  else info(`Error: ${(e as Error)?.message ?? e}`)
  return usage ? 2 : 1
}
