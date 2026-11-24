import { afterEach, describe, expect, it } from 'vitest'
import { PupsClient } from '../src/client.js'
import { isPupsError, type PupsErrorCode } from '../src/errors.js'
import { ARCHIVE_SPEC, FEED_REL, feedScopes, PUPS_FEED_SPEC, type FeedDocument, type PupsFeed } from '../src/feed.js'
import type { Scope } from '../src/scopes.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import { createMockServer, type MockOptions } from './mock-server.js'

const clientId = 'https://app.example/oauth/client.json'
const origin = 'https://tim.example.com'
const clients: PupsClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

async function connect(scopes: Scope[] = ['identify', ...feedScopes(), ...feedScopes('photos')], options: MockOptions = {}) {
  const mock = createMockServer({ maxUploadBytes: 1_000_000, ...options })
  const client = new PupsClient({ clientId, redirectUri: 'https://app.example/callback', store: new MemoryTokenStore(), fetch: mock.fetch })
  clients.push(client)
  const pending = await client.createAuthorization('tim.example.com', { scopes })
  const { session } = await client.completeAuthorization(mock.authorize(pending.url), pending)
  return { mock, session: session! }
}

type Mock = Awaited<ReturnType<typeof connect>>['mock']

const read = (mock: Mock, path: string): FeedDocument => JSON.parse(new TextDecoder().decode(mock.state.files.get(path)!.body))
const writeRaw = (mock: Mock, path: string, value: unknown) =>
  mock.state.files.set(path, { body: new TextEncoder().encode(JSON.stringify(value)), type: 'application/json', etag: `"raw-${Math.random()}"` })
const ids = (doc: FeedDocument) => doc.items.map(item => item.id)
const range = (from: number, to: number) => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => `p${from < to ? from + i : from - i}`)

async function errorCode(promise: Promise<unknown>): Promise<PupsErrorCode | 'ok'> {
  try {
    await promise
    return 'ok'
  } catch (e) {
    if (isPupsError(e)) return e.code
    throw e
  }
}

async function postMany(feed: PupsFeed, from: number, to: number) {
  for (let i = from; i <= to; i++) await feed.addPost({ id: `p${i}`, content_text: `Post ${i}` })
}

async function allIds(feed: PupsFeed) {
  const result: string[] = []
  for await (const item of feed.posts()) result.push(item.id)
  return result
}

const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })

describe('setting up a feed', () => {
  it('creates the feed with the fixed fields and registers it in host-meta.json', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    expect(await feed.load()).toEqual({ status: 'missing' })
    const result = await feed.create({ title: "Tim's Notes", description: 'Notes', language: 'en', icon: png() })
    expect(result).toEqual({ url: `${origin}/feed.json`, registered: true })

    const doc = read(mock, '/feed.json')
    expect(doc).toMatchObject({
      version: 'https://jsonfeed.org/version/1.1',
      title: "Tim's Notes",
      home_page_url: `${origin}/`,
      feed_url: `${origin}/feed.json`,
      description: 'Notes',
      language: 'en',
      items: [],
      _pups: { pupsControlled: true },
    })
    expect(doc.user_comment).toContain('Personal Upload Server (PUPS)')
    expect(doc.icon).toMatch(/^https:\/\/tim\.example\.com\/feed\/images\/icons\/icon-[\w-]+\.png$/)
    expect(mock.state.files.has(new URL(doc.icon!).pathname)).toBe(true)
    expect(mock.state.hostMeta.links).toContainEqual(expect.objectContaining({ rel: FEED_REL, href: `${origin}/feed.json` }))
    expect((await feed.load()).status).toBe('pups')
  })

  it('refuses to create a feed that exists, and registers a feed only once', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'A' })
    expect(await errorCode(feed.create({ title: 'B' }))).toBe('precondition_failed')
    expect(await feed.register()).toBe(true)
    expect(mock.state.hostMeta.links.filter(l => l.rel == FEED_REL)).toHaveLength(1)
  })

  it('rejects fixed fields and a missing title', async () => {
    const { session } = await connect()
    const feed = session.feed()
    expect(await errorCode(feed.create({ title: ' ' }))).toBe('invalid_request')
    expect(await errorCode(feed.create({ title: 'A', feed_url: 'x' } as never))).toBe('invalid_request')
    expect(await errorCode(feed.create({ title: 'A', hubs: [] } as never))).toBe('invalid_request')
  })

  it('needs the scopes of the feed', async () => {
    const { session } = await connect(['identify', 'appdata'])
    const feed = session.feed()
    expect(feed.writable).toBe(false)
    expect(await errorCode(feed.create({ title: 'A' }))).toBe('insufficient_scope')
    expect(feedScopes()).toEqual(['write:/feed.json', 'write:/feed/'])
    expect(feedScopes('photos')).toEqual(['write:/feed/photos.json', 'write:/feed/photos/'])
  })
})

describe('feeds maintained by other means', () => {
  const handMade = { version: 'https://jsonfeed.org/version/1', title: 'Hand-made', home_page_url: 'https://old.example/', author: { name: 'Tim' }, items: [{ id: 'old', content_text: 'Old' }] }

  it('never writes a feed without the _pups marker', async () => {
    const { mock, session } = await connect()
    writeRaw(mock, '/feed.json', handMade)
    const etag = mock.state.files.get('/feed.json')!.etag
    const feed = session.feed()
    expect((await feed.load()).status).toBe('foreign')
    expect(await errorCode(feed.addPost({ content_text: 'Hi' }))).toBe('not_pups_controlled')
    expect(await errorCode(feed.updateSettings({ title: 'Mine' }))).toBe('not_pups_controlled')
    expect(await errorCode(feed.editPost('old', { title: 'x' }))).toBe('not_pups_controlled')
    expect(await errorCode(feed.deletePost('old'))).toBe('not_pups_controlled')
    expect(await errorCode(feed.create({ title: 'Mine' }))).toBe('precondition_failed')
    expect(mock.state.files.get('/feed.json')!.etag).toBe(etag)
  })

  it('reports files that are not JSON Feeds', async () => {
    const { mock, session } = await connect()
    writeRaw(mock, '/feed.json', { hello: 'world' })
    expect(await session.feed().load()).toEqual({ status: 'invalid' })
  })

  it('takes over a feed the owner marked, and sets the fixed fields on the first write', async () => {
    const { mock, session } = await connect()
    writeRaw(mock, '/feed.json', { ...handMade, _pups: { pupsControlled: true } })
    await session.feed().addPost({ id: 'new', content_text: 'New' })
    const doc = read(mock, '/feed.json')
    expect(doc).toMatchObject({ version: 'https://jsonfeed.org/version/1.1', home_page_url: `${origin}/`, feed_url: `${origin}/feed.json`, authors: [{ name: 'Tim' }] })
    expect(doc.author).toBeUndefined()
    expect(ids(doc)).toEqual(['new', 'old'])
  })
})

describe('posting', () => {
  it('sends posts to the server, which archives them and keeps the newest 30 in the feed file', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes', _podcast: { medium: 'podcast', liveItems: [] } })
    const first = await feed.addPost({ id: 'p1', content_text: 'Post 1' })
    expect(first).toMatchObject({ id: 'p1', index: 0, url: `${origin}/feed/feed.000000.json#p1`, item: { content_text: 'Post 1', _archive: { index: 0 } } })
    expect(mock.state.requests.at(-1)).toEqual({ method: 'POST', url: `${origin}/files/feed.json` })
    await postMany(feed, 2, 20)
    expect((await feed.addPost({ id: 'p21', content_text: 'Post 21' })).url).toBe(`${origin}/feed/feed.000001.json#p21`)
    await postMany(feed, 22, 45)
    const main = read(mock, '/feed.json')
    expect(ids(main)).toEqual(range(45, 16))
    expect(main._pups).toEqual({ about: PUPS_FEED_SPEC, pupsControlled: true })
    expect(main._archive).toEqual({ about: ARCHIVE_SPEC, archive_url: `${origin}/feed/feed.000002.json`, archive_template: `${origin}/feed/feed.{number}.json`, archive_size: 20 })
    expect(ids(read(mock, '/feed/feed.000001.json'))).toEqual(range(40, 21))
    const newest = read(mock, '/feed/feed.000002.json')
    expect(newest).toMatchObject({ next_url: `${origin}/feed/feed.000001.json`, _archive: { updates_url: `${origin}/feed.json`, number: 2, next_index: 45 }, _podcast: { medium: 'podcast' } })
    expect(newest._podcast).not.toHaveProperty('liveItems')
    expect(await allIds(feed)).toEqual(range(45, 1))
    expect((await feed.getPost('p3'))!.url).toBe(`${origin}/feed/feed.000000.json#p3`)
  })

  it('generates ids and dates, and stores Markdown with a text fallback', async () => {
    const { session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    const result = await feed.addPost({ markdown: '**Hi**', date_published: new Date('2026-11-15T10:00:00Z') })
    expect(result.id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(result.url).toBe(`${origin}/feed/feed.000000.json#${result.id}`)
    expect(result.item).toMatchObject({ content_text: '**Hi**', date_published: '2026-11-15T10:00:00.000Z', _source: { markdown: '**Hi**' } })
    expect((await feed.addPost({ content_html: '<p>x</p>' })).item.date_published).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(await errorCode(feed.addPost({ title: 'No content' }))).toBe('invalid_request')
  })

  it('ignores an index or a delete in the input: the server gives new posts their index', async () => {
    const { session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await feed.addPost({ id: 'a', content_text: 'a' })
    const b = await feed.addPost({ id: 'b', content_text: 'b', _archive: { index: 0, other: 1 }, _pups: { delete: true } } as never)
    expect(b.item._archive).toEqual({ other: 1, index: 1 })
    expect(await allIds(feed)).toEqual(['b', 'a'])
  })

  it('loses no post when two clients post at the same time', async () => {
    const { mock, session } = await connect()
    await session.feed().create({ title: 'Notes' })
    const a = session.feed()
    const b = session.feed()
    await Promise.all([postMany(a, 1, 25), (async () => {
      for (let i = 26; i <= 50; i++) await b.addPost({ id: `p${i}`, content_text: `Post ${i}` })
    })()])
    expect((await allIds(a)).sort()).toEqual(range(1, 50).sort())
    expect(read(mock, '/feed.json').items).toHaveLength(30)
  })

  it('needs a server that keeps feeds, and a feed that it keeps', async () => {
    const { session } = await connect(undefined, { keptFeeds: false })
    expect(session.server.keptFeeds).toBe(false)
    expect(await errorCode(session.feed().create({ title: 'Notes' }))).toBe('unsupported')
    expect(await errorCode(session.feed().addPost({ content_text: 'x' }))).toBe('unsupported')
    const other = await connect()
    expect(await errorCode(other.session.feed().addPost({ content_text: 'x' }))).toBe('not_found')
  })

  it('never writes the archives itself', async () => {
    const { session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await feed.addPost({ id: 'p1', content_text: 'x' })
    expect(await errorCode(session.put('/feed/feed.000000.json', { version: 'https://jsonfeed.org/version/1.1', items: [] }))).toBe('insufficient_scope')
  })

  it('posts through the POST fallback', async () => {
    const { mock, session } = await connect(undefined, { postFallback: true })
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    expect((await feed.addPost({ id: 'p1', content_text: 'x' })).index).toBe(0)
    expect(mock.state.requests.at(-1)).toEqual({ method: 'POST', url: `${origin}/pups/post?method=POST&path=%2Ffeed.json` })
  })
})

describe('editing and deleting', () => {
  it('edits posts in their archive, and in the feed file if they are there; they keep their index', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 35)

    const archived = await feed.editPost('p3', { title: 'Third', markdown: '*3*' })
    expect(archived).toMatchObject({ url: `${origin}/feed/feed.000000.json#p3`, index: 2 })
    const item = read(mock, '/feed/feed.000000.json').items.find(i => i.id == 'p3')!
    expect(item).toMatchObject({ title: 'Third', content_text: '*3*', _source: { markdown: '*3*' }, _archive: { index: 2 } })
    expect(item.date_modified).toBeDefined()
    expect(ids(read(mock, '/feed.json'))).not.toContain('p3')

    await feed.editPost('p35', current => ({ ...current, content_text: 'Changed', _archive: { index: 0 } }))
    expect(read(mock, '/feed.json').items[0]).toMatchObject({ id: 'p35', content_text: 'Changed', _archive: { index: 34 } })
    expect(read(mock, '/feed/feed.000001.json').items[0]).toMatchObject({ id: 'p35', content_text: 'Changed' })
    await feed.editPost('p34', { title: 'T' })
    await feed.editPost('p34', { title: null })
    expect(read(mock, '/feed.json').items[1]).not.toHaveProperty('title')
    expect(await errorCode(feed.editPost('p34', { content_text: null }))).toBe('invalid_request')
    expect(await errorCode(feed.editPost('nope', { title: 'x' }))).toBe('not_found')
    const requests = mock.state.requests.length
    expect((await feed.editPost('p34', () => undefined)).id).toBe('p34')
    expect(mock.state.requests.slice(requests).some(r => r.method == 'POST')).toBe(false)
  })

  it('deletes posts; the server fills the feed file up again, and never gives out an index again', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 35)
    expect((await feed.deletePost('p2')).item).toMatchObject({ id: 'p2', content_text: 'Post 2' })
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual([...range(20, 3), 'p1'])
    await feed.deletePost('p35')
    expect(ids(read(mock, '/feed.json'))).toEqual(range(34, 5))
    expect(await feed.getPost('p2')).toBeUndefined()
    expect(await errorCode(feed.deletePost('p2'))).toBe('not_found')
    expect((await feed.addPost({ id: 'p36', content_text: '36' })).index).toBe(35)
  })

  it('deletes media that only the deleted post uses', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Photos' })
    const own = await feed.uploadMedia(png())
    const shared = await feed.uploadMedia({ body: new Uint8Array([1, 2, 3]), type: 'audio/mpeg' })
    expect(own.url).toMatch(new RegExp(`^${origin}/feed/images/\\d{4}/[\\w-]+\\.png$`))
    expect(shared).toMatchObject({ type: 'audio/mpeg', size: 3 })
    expect(shared.path).toMatch(/^\/feed\/media\/\d{4}\/[\w-]+\.mp3$/)
    await feed.addPost({ id: 'a', content_html: `<img src="${own.url}">`, attachments: [{ url: shared.url, mime_type: 'audio/mpeg' }] })
    await feed.addPost({ id: 'b', content_text: 'b', attachments: [{ url: shared.url, mime_type: 'audio/mpeg' }] })
    const { deletedMedia } = await feed.deletePost('a', { deleteMedia: true })
    expect(deletedMedia).toEqual([own.url])
    expect(mock.state.files.has(own.path)).toBe(false)
    expect(mock.state.files.has(shared.path)).toBe(true)
    expect(await errorCode(feed.uploadMedia({ body: 'x', extension: 'html' }))).toBe('unsupported_type')
    expect(await errorCode(feed.uploadMedia(png(), { folder: 'images/icons' }))).toBe('invalid_request')
    expect(await errorCode(session.feed('photos').uploadMedia(png(), { folder: 'comments' }))).toBe('invalid_request')
    expect(await errorCode(feed.uploadMedia(png(), { folder: 'photos' }))).toBe('invalid_request')
    expect((await feed.uploadMedia(png(), { folder: 'media/covers' })).path).toMatch(/^\/feed\/media\/covers\/\d{4}\//)
  })
})

describe('feed settings', () => {
  it('updates the owner\'s fields and nothing else; the server keeps the items', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes', description: 'Old' })
    await postMany(feed, 1, 21)
    writeRaw(mock, '/feed.json', { ...read(mock, '/feed.json'), _unknown: { kept: true } })
    await feed.updateSettings({ title: 'New', description: null, _podcast: { explicit: false } })
    const doc = read(mock, '/feed.json')
    expect(doc).toMatchObject({ title: 'New', _podcast: { explicit: false }, _unknown: { kept: true } })
    expect(doc).not.toHaveProperty('description')
    expect(ids(doc)).toEqual(range(21, 1))
    expect(doc._archive!.archive_url).toBe(`${origin}/feed/feed.000001.json`)
    expect(await errorCode(feed.updateSettings({ next_url: 'x' } as never))).toBe('invalid_request')
    expect(await errorCode(feed.updateSettings({ icon: 'x' } as never))).toBe('invalid_request')
    expect(await errorCode(feed.updateSettings({ title: null }))).toBe('invalid_request')
  })

  it('replaces icons and deletes the old file', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes', favicon: png() })
    const oldPath = new URL(read(mock, '/feed.json').favicon!).pathname
    await feed.setFavicon(new File([new Uint8Array([1])], 'f.webp'))
    const doc = read(mock, '/feed.json')
    expect(doc.favicon).toMatch(/\/feed\/images\/icons\/favicon-[\w-]+\.webp$/)
    expect(mock.state.files.has(oldPath)).toBe(false)
    await feed.setFavicon(null)
    expect(read(mock, '/feed.json')).not.toHaveProperty('favicon')
    expect(mock.state.files.has(new URL(doc.favicon!).pathname)).toBe(false)
  })
})

describe('named feeds', () => {
  it('lives in /feed/<name>.json with its files in /feed/<name>/', async () => {
    const { mock, session } = await connect()
    const photos = session.feed('photos')
    expect(photos).toMatchObject({ name: 'photos', path: '/feed/photos.json', directory: '/feed/photos/', url: `${origin}/feed/photos.json` })
    expect(() => session.feed('Photos')).toThrow(/not a valid feed name/)
    expect(() => session.feed('-x')).toThrow(/not a valid feed name/)
    expect(() => session.feed('images')).toThrow(/belong to the main feed/)
    expect(() => session.feed('media')).toThrow(/belong to the main feed/)
    expect(() => session.feed('comments')).toThrow(/belong to the main feed/)
    await photos.create({ title: 'Photos', icon: png() })
    expect(read(mock, '/feed/photos.json').icon).toMatch(new RegExp(`^${origin}/feed/photos/images/icons/icon-[\\w-]+\\.png$`))
    for (let i = 1; i <= 21; i++) await photos.addPost({ id: `p${i}`, content_text: `${i}` })
    const doc = read(mock, '/feed/photos.json')
    expect(doc).toMatchObject({ feed_url: `${origin}/feed/photos.json`, home_page_url: `${origin}/`, _archive: { archive_url: `${origin}/feed/photos/feed.000001.json`, archive_template: `${origin}/feed/photos/feed.{number}.json` } })
    expect(ids(read(mock, '/feed/photos/feed.000001.json'))).toEqual(['p21'])
    expect(read(mock, '/feed/photos/feed.000001.json')).toMatchObject({ next_url: `${origin}/feed/photos/feed.000000.json`, _archive: { updates_url: `${origin}/feed/photos.json`, number: 1 } })
    expect((await photos.uploadMedia(png())).path).toMatch(/^\/feed\/photos\/images\/\d{4}\//)
  })

  it('never takes a named feed\'s files for media of the main feed', async () => {
    const { mock, session } = await connect()
    const main = session.feed()
    const photos = session.feed('photos')
    await main.create({ title: 'Notes' })
    await photos.create({ title: 'Photos' })
    const photo = await photos.uploadMedia(png())
    await main.addPost({ id: 'n', content_html: `<img src="${photo.url}">` })
    expect((await main.deletePost('n', { deleteMedia: true })).deletedMedia).toEqual([])
    expect(mock.state.files.has(photo.path)).toBe(true)
  })

  it('lists the feeds registered in host-meta.json', async () => {
    const { mock, session } = await connect()
    await session.feed().create({ title: 'Notes' })
    await session.feed('photos').create({ title: 'Photos' })
    mock.state.hostMeta.links.push({ rel: FEED_REL, href: 'https://elsewhere.example/feed.json' })
    const feeds = await session.listFeeds()
    expect(feeds.map(f => [f.url, f.feed?.path])).toEqual([
      [`${origin}/feed.json`, '/feed.json'],
      [`${origin}/feed/photos.json`, '/feed/photos.json'],
      ['https://elsewhere.example/feed.json', undefined],
    ])
  })
})

describe('comments', () => {
  const comments = `${origin}/pups/comments`
  const withReceiver = () => connect(undefined, { commentEndpoint: true })

  it('opens the feed for comments through the PUPS server, and closes it again', async () => {
    const { mock, session } = await withReceiver()
    expect(session.server.commentEndpoint).toBe(comments)
    const feed = session.feed()
    expect(feed.commentsAvailable).toBe(true)
    await feed.create({ title: 'Notes' })
    expect(feed.comments(read(mock, '/feed.json'))).toBe('off')
    await feed.enableComments({ policy: { maxLength: 500, requireSocialSpec: true }, tos: `${origin}/tos.html` })
    const doc = read(mock, '/feed.json')
    expect(doc._submissions).toEqual({
      about: 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md',
      url: comments,
      tos: `${origin}/tos.html`,
      policies: { comments: { title: 'none', minLength: 2, maxLength: 500, maxDepth: 5, requireSocialSpec: true } },
      republish: 'full',
    })
    expect(feed.comments(doc)).toBe('pups')
    for (const republish of ['summary', 'no'] as const) {
      await feed.enableComments({ republish })
      expect(read(mock, '/feed.json')._submissions).toMatchObject({ republish })
    }
    await feed.disableComments()
    expect(read(mock, '/feed.json')).not.toHaveProperty('_submissions')
  })

  it('tells comments through another service apart, and replaces them only when asked', async () => {
    const { mock, session } = await withReceiver()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await feed.updateSettings({ _submissions: { url: 'https://rm.example.org/groups/tim/mention', republish: 'full' } })
    expect(feed.comments(read(mock, '/feed.json'))).toBe('other')
    await feed.enableComments()
    expect(read(mock, '/feed.json')._submissions).toMatchObject({ url: comments, policies: { comments: { title: 'none', minLength: 2, maxLength: 2000, maxDepth: 5 } } })
  })

  it('needs a server with a comment endpoint', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    expect(feed.commentsAvailable).toBe(false)
    expect(await errorCode(feed.enableComments())).toBe('unsupported')
    await feed.updateSettings({ _submissions: { url: comments, republish: 'no' } })
    expect(feed.comments(read(mock, '/feed.json'))).toBe('other')
  })

  it('leaves _submissions out of the archives: the feed file alone says whether the feed accepts comments', async () => {
    const { mock, session } = await withReceiver()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await feed.enableComments()
    await postMany(feed, 1, 21)
    for (const n of [0, 1]) expect(read(mock, `/feed/feed.00000${n}.json`)).not.toHaveProperty('_submissions')
    expect(read(mock, '/feed.json')._submissions).toMatchObject({ url: comments })
  })
})
