import { describe, expect, it } from 'vitest'
import { normalizeDomain, parseConfig } from '../src/discovery.js'
import { isPupsError } from '../src/errors.js'
import { fileTypeOf, uploadContentType } from '../src/file-types.js'
import { isPrivate, pathFromPublicUrl, publicUrl, validatePath } from '../src/paths.js'
import { expandScopes, validateScopes } from '../src/scopes.js'
import { createMockServer } from './mock-server.js'

const server = parseConfig(createMockServer().state.config, 'https://tim.example.com/', ['tim.example.com'])
const clientId = 'https://app.example/oauth/client.json'

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    if (isPupsError(e)) return e.code
    throw e
  }
  return 'ok'
}

describe('normalizeDomain', () => {
  it.each([
    ['tim.example.com', 'https://tim.example.com/'],
    ['  Tim.Example.COM ', 'https://tim.example.com/'],
    ['https://tim.example.com/some/page?x#y', 'https://tim.example.com/'],
    ['http://tim.example.com', 'https://tim.example.com/'],
    ['tim.example.com:8443', 'https://tim.example.com/'],
    ['bücher.example', 'https://xn--bcher-kva.example/'],
  ])('%s → %s', (input, expected) => expect(normalizeDomain(input)).toBe(expected))

  it.each(['', 'localhost', 'ftp://tim.example.com', 'not a domain'])('rejects %j', input =>
    expect(code(() => normalizeDomain(input))).toBe('invalid_domain'))
})

describe('validatePath', () => {
  it.each([
    '/appdata/app.example/comments.json',
    '/feed/images/2026/photo.jpg',
    '/.well-known/about.md',
    '/appdata/app.example/ünïcode name.md',
  ])('accepts %s', path => expect(code(() => validatePath(path, server.wellKnownPaths))).toBe('ok'))

  it.each([
    'relative.json',
    '/appdata/app.example/../x.json',
    '/appdata/./x.json',
    '/appdata//x.json',
    '/appdata/app.example/dir/',
    '/appdata/app.example/.htaccess',
    '/.well-known/following.opml',
    '/appdata/app.example/feed.php.',
    '/appdata/app.example/dir /x.json',
    '/appdata/app.example/a\\b.json',
    '/appdata/app.example/c:x.json',
    '/appdata/app.example/nul\u0000.json',
    `/appdata/${'x'.repeat(520)}.json`,
    '/appdata/\ud800.json',
  ])('rejects %j', path => expect(code(() => validatePath(path, server.wellKnownPaths))).toBe('invalid_path'))
})

describe('file types', () => {
  it('derives the type from the extension', () => {
    expect(uploadContentType('/a/feed.json')).toBe('application/json; charset=utf-8')
    expect(uploadContentType('/a/feed.json', 'application/feed+json')).toBe('application/feed+json; charset=utf-8')
    expect(uploadContentType('/a/Photo.JPG')).toBe('image/jpeg')
    expect(uploadContentType('/a/feed.xml', 'application/rss+xml; charset=utf-8')).toBe('application/rss+xml; charset=utf-8')
  })

  it.each(['/a/index.html', '/a/x.js', '/a/style.css', '/a/feed.php.json', '/a/x.phtml', '/a/noextension', '/a/x.exe'])(
    'rejects %s', path => expect(code(() => fileTypeOf(path))).toBe('unsupported_type'))

  it('rejects a Content-Type that does not match the extension', () =>
    expect(code(() => uploadContentType('/a/x.png', 'image/jpeg'))).toBe('unsupported_type'))
})

describe('scopes', () => {
  it('expands appdata', () =>
    expect(expandScopes(['identify', 'appdata', 'appdata'], clientId)).toEqual(['identify', 'write:/appdata/app.example/']))

  it.each([
    [['identify', 'write:/appdata/app.example/'], 'ok'],
    [['write:/feed/photos/'], 'ok'],
    [['write:/feed/photos/2026/'], 'ok'],
    [['write:/.well-known/about.md'], 'ok'],
    [['write:/appdata/other.example/'], 'invalid_scope'],
    [['write:/appdata/'], 'invalid_scope'],
    [['write:/appdata/app.example/sub/'], 'invalid_scope'],
    [['write:/'], 'invalid_scope'],
    [['write:/.well-known/host-meta.json'], 'invalid_scope'],
    [['read:/x'], 'invalid_scope'],
    [['read:/pups/private/notes/'], 'ok'],
    [['read:/pups/private/notes/todo.json'], 'ok'],
    [['write:/pups/private/notes/'], 'ok'],
    [['read:/pups/private/other/'], 'invalid_scope'],
    [['read:/pups/private/'], 'invalid_scope'],
    [['read:/feed/'], 'invalid_scope'],
    [['read:/appdata/app.example/'], 'invalid_scope'],
    [['read:/appdata/app.example/private/'], 'invalid_scope'],
    [[], 'invalid_scope'],
  ])('%j → %s', (scopes, expected) => expect(code(() => validateScopes(scopes, server, clientId))).toBe(expected))
})

describe('private areas', () => {
  it.each([
    ['/pups/private/notes/a.json', true],
    ['/appdata/app.example/private/a.json', true],
    ['/APPDATA/app.example/Private/a.json', true],
    ['/appdata/app.example/private', false],
    ['/appdata/app.example/privates/a.json', false],
    ['/appdata/app.example/x/private/a.json', false],
    ['/pups/pages/private/a.md', false],
  ])('%s → %s', (path, expected) => expect(isPrivate(path)).toBe(expected))

  it('private files have no public URL', () => {
    expect(code(() => publicUrl(server, '/appdata/app.example/private/a.json'))).toBe('invalid_path')
    expect(pathFromPublicUrl(server, 'https://tim.example.com/files/appdata/app.example/private/a.json')).toBeUndefined()
    expect(pathFromPublicUrl(server, 'https://tim.example.com/files/pups/private/notes/a.json')).toBeUndefined()
  })
})

describe('public URLs', () => {
  it('uses public_base, or the url of a well-known entry', () => {
    expect(publicUrl(server, '/appdata/app.example/a b.json')).toBe('https://tim.example.com/files/appdata/app.example/a%20b.json')
    expect(publicUrl(server, '/.well-known/about.md')).toBe('https://tim.example.com/.well-known/about.md')
  })

  it('maps public URLs back to paths', () => {
    expect(pathFromPublicUrl(server, 'https://tim.example.com/files/appdata/app.example/a%20b.json')).toBe('/appdata/app.example/a b.json')
    expect(pathFromPublicUrl(server, 'https://tim.example.com/.well-known/about.md')).toBe('/.well-known/about.md')
    expect(pathFromPublicUrl(server, 'https://elsewhere.example/x.json')).toBeUndefined()
  })
})

describe('parseConfig', () => {
  const config = createMockServer().state.config
  it('rejects unsupported versions and invalid fields', () => {
    expect(code(() => parseConfig({ ...config, spec_version: '0.2' }, 'https://x.example/', []))).toBe('unsupported_server_version')
    expect(code(() => parseConfig({ ...config, storage_base: 'https://x.example/files' }, 'https://x.example/', []))).toBe('invalid_server_config')
    expect(code(() => parseConfig({ ...config, token_endpoint: 'http://x.example/token' }, 'https://x.example/', []))).toBe('invalid_server_config')
    expect(code(() => parseConfig({ ...config, max_upload_bytes: -1 }, 'https://x.example/', []))).toBe('invalid_server_config')
  })
})

describe('network errors', () => {
  const failingFetch = (code: string): typeof fetch => async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ${code}`), { code }) })
  }

  it('explains why a host could not be reached', async () => {
    const { fetchWithTimeout } = await import('../src/util.js')
    await expect(fetchWithTimeout(failingFetch('ENOTFOUND'), 'https://alice.pubs.test/x', {}, 1000))
      .rejects.toThrow("Could not reach alice.pubs.test: the domain name doesn't exist. Check the spelling.")
    await expect(fetchWithTimeout(failingFetch('DEPTH_ZERO_SELF_SIGNED_CERT'), 'https://alice.pups.test/x', {}, 1000))
      .rejects.toThrow('self-signed')
  })
})
