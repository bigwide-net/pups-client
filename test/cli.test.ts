import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTokenStore } from '../src/cli/file-store.js'
import { loopbackLogin } from '../src/cli/loopback.js'
import { cliClientMetadata, clientIdFor, main } from '../src/cli/main.js'
import { clientMetadataProblems } from '../src/client.js'
import { createMockServer } from './mock-server.js'

const realFetch = globalThis.fetch
let dir: string
let stdout: string[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pups-cli-'))
  vi.stubEnv('PUPS_CONFIG_DIR', dir)
  stdout = []
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => (stdout.push(String(chunk)), true))
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('client metadata', () => {
  it('derives the client_id from a domain', () => {
    expect(clientIdFor('Tim.Example.App')).toBe('https://tim.example.app/pups-cli.json')
    expect(clientIdFor('https://tim.example.app/x.json')).toBe('https://tim.example.app/x.json')
  })

  it('produces a document a PUPS server accepts for any loopback port', () => {
    const clientId = clientIdFor('tim.example.app')
    expect(clientMetadataProblems(cliClientMetadata(clientId), clientId, 'http://127.0.0.1:53123/callback')).toEqual([])
  })
})

describe('pups CLI', () => {
  it('signs in through a loopback redirect, uploads, and logs out', async () => {
    const mock = createMockServer({ domain: 'tjansen.de' })
    const clientId = clientIdFor('tim.example.app')
    const store = new FileTokenStore(join(dir, 'sessions.json'))
    const session = await loopbackLogin({
      clientId,
      domain: 'tjansen.de',
      scopes: ['appdata'],
      store,
      fetch: mock.fetch,
      // The "browser": consent at the mock server, then follow the redirect to the loopback listener.
      openBrowser: async url => void await realFetch(mock.authorize(url)),
    })
    expect(session.me).toBe('https://tjansen.de/')
    expect((await stat(store.file)).mode & 0o777).toBe(0o600)

    // Later commands use the stored session; the global fetch goes to the mock server.
    vi.stubGlobal('fetch', mock.fetch)
    expect(await main(['whoami', '--json'])).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({ me: 'https://tjansen.de/', client: clientId, scopes: ['write:/appdata/tim.example.app/'] })

    const local = join(dir, 'hello.md')
    await writeFile(local, '# Hello')
    stdout = []
    expect(await main(['put', local, '--to', 'notes/'])).toBe(0)
    expect(stdout.join('')).toBe('https://tjansen.de/files/appdata/tim.example.app/notes/hello.md\n')
    expect(new TextDecoder().decode(mock.state.files.get('/appdata/tim.example.app/notes/hello.md')!.body)).toBe('# Hello')

    expect(await main(['put', local, '--to', 'notes/hello.md', '--create'])).toBe(1)
    expect(await main(['get', 'notes/hello.md', '-o', join(dir, 'copy.md')])).toBe(0)
    expect(await readFile(join(dir, 'copy.md'), 'utf8')).toBe('# Hello')
    expect(await main(['rm', 'notes/hello.md'])).toBe(0)
    expect(mock.state.files.size).toBe(0)

    expect(await main(['logout'])).toBe(0)
    expect(mock.state.grants[0]!.revoked).toBe(true)
    expect(await store.listAll()).toEqual([])
    expect(await main(['whoami'])).toBe(2)
  })

  it('rejects unknown commands and missing arguments', async () => {
    expect(await main(['frobnicate'])).toBe(2)
    expect(await main(['login', 'tjansen.de'])).toBe(2)
    expect(await main(['--version'])).toBe(0)
  })
})
