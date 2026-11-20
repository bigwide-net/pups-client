import { afterEach, describe, expect, it } from 'vitest'
import { PupsClient } from '../src/client.js'
import { isPupsError, type PupsErrorCode } from '../src/errors.js'
import { FEED_REL, feedScopes, type FeedDocument, type PupsFeed } from '../src/feed.js'
import type { Scope } from '../src/scopes.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import { createMockServer } from './mock-server.js'

const clientId = 'https://app.example/oauth/client.json'
const origin = 'https://tim.example.com'
const clients: PupsClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

async function connect(scopes: Scope[] = ['identify', ...feedScopes(), ...feedScopes('photos')]) {
  const mock = createMockServer({ maxUploadBytes: 1_000_000 })
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
    expect(mock.state.files.get('/feed.json')!.type).toContain('application/feed+json')
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

describe('posting and archiving', () => {
  it('adds every post to the newest archive and to the feed file, which keeps the newest 30', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes', _podcast: { medium: 'podcast', liveItems: [] } })
    const first = await feed.addPost({ id: 'p1', content_text: 'Post 1' })
    expect(first.url).toBe(`${origin}/feed/feed.000000.json#p1`)
    await postMany(feed, 2, 20)
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual(range(20, 1))
    expect(read(mock, '/feed.json')._pups!.archive_url).toBe(`${origin}/feed/feed.000000.json`)

    expect((await feed.addPost({ id: 'p21', content_text: 'Post 21' })).url).toBe(`${origin}/feed/feed.000001.json#p21`)
    await postMany(feed, 22, 45)
    const main = read(mock, '/feed.json')
    expect(ids(main)).toEqual(range(45, 16))
    expect(main.next_url).toBeUndefined()
    expect(main._pups).toMatchObject({ pupsControlled: true, archive_url: `${origin}/feed/feed.000002.json` })
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual(range(20, 1))
    expect(ids(read(mock, '/feed/feed.000001.json'))).toEqual(range(40, 21))
    const newest = read(mock, '/feed/feed.000002.json')
    expect(ids(newest)).toEqual(range(45, 41))
    expect(newest).toMatchObject({
      title: 'Notes',
      feed_url: `${origin}/feed/feed.000002.json`,
      next_url: `${origin}/feed/feed.000001.json`,
      _pups: { pupsControlled: true, updates_url: `${origin}/feed.json` },
      _podcast: { medium: 'podcast' },
    })
    expect(newest._pups).not.toHaveProperty('archive_url')
    expect(newest._podcast).not.toHaveProperty('liveItems')
    expect(newest.user_comment).toContain(`This is an archive of ${origin}/feed.json`)
    expect(read(mock, '/feed/feed.000000.json').next_url).toBeUndefined()
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
    expect(await errorCode(feed.addPost({ id: result.id, content_text: 'Duplicate' }))).toBe('invalid_request')
  })

  it('loses no post when two clients post at the same time', async () => {
    const { mock, session } = await connect()
    await session.feed().create({ title: 'Notes' })
    const a = session.feed(undefined, { maxAttempts: 50 })
    const b = session.feed(undefined, { maxAttempts: 50 })
    await Promise.all([postMany(a, 1, 25), (async () => {
      for (let i = 26; i <= 50; i++) await b.addPost({ id: `p${i}`, content_text: `Post ${i}` })
    })()])
    const all = await allIds(a)
    expect(all.sort()).toEqual(range(1, 50).sort())
    expect(read(mock, '/feed.json').items).toHaveLength(30)
    const archived = [0, 1, 2].flatMap(n => ids(read(mock, `/feed/feed.00000${n}.json`)))
    expect(archived).toHaveLength(50)
  })

  it('repairs the feed file from the newest archive after an interrupted post', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 3)
    // A post that reached the archive, but not the feed file.
    const archive = read(mock, '/feed/feed.000000.json')
    writeRaw(mock, '/feed/feed.000000.json', { ...archive, items: [{ id: 'lost', content_text: 'Lost' }, ...archive.items] })
    await feed.addPost({ id: 'p4', content_text: 'Post 4' })
    expect(ids(read(mock, '/feed.json'))).toEqual(['p4', 'lost', 'p3', 'p2', 'p1'])
  })

  it('keeps fewer items in the feed file when the optional byte limit is reached, but at least 10', async () => {
    const { mock, session } = await connect()
    const feed = session.feed(undefined, { maxBytes: 4000 })
    await feed.create({ title: 'Long posts' })
    for (let i = 1; i <= 25; i++) await feed.addPost({ id: `p${i}`, content_text: 'x'.repeat(300) })
    const main = read(mock, '/feed.json')
    expect(main.items.length).toBeLessThan(25)
    expect(main.items.length).toBeGreaterThanOrEqual(10)
    expect(await allIds(feed)).toEqual(range(25, 1))
  })

  it('starts the archives of a handed-over feed with its items, and continues its chain', async () => {
    const { mock, session } = await connect()
    const old = range(25, 1).map(id => ({ id: `old-${id}`, content_text: id }))
    writeRaw(mock, '/feed.json', { version: 'https://jsonfeed.org/version/1.1', title: 'Old', next_url: 'https://old.example/page2.json', items: old, _pups: { pupsControlled: true } })
    const feed = session.feed()
    expect((await feed.addPost({ id: 'new', content_text: 'New' })).url).toBe(`${origin}/feed/feed.000001.json#new`)
    const first = read(mock, '/feed/feed.000000.json')
    expect(ids(first)).toEqual(range(20, 1).map(id => `old-${id}`))
    expect(first.next_url).toBe('https://old.example/page2.json')
    expect(ids(read(mock, '/feed/feed.000001.json'))).toEqual(['new', ...range(25, 21).map(id => `old-${id}`)])
    const main = read(mock, '/feed.json')
    expect(main.next_url).toBeUndefined()
    expect(main._pups!.archive_url).toBe(`${origin}/feed/feed.000001.json`)
    expect(ids(main)).toEqual(['new', ...range(25, 1).map(id => `old-${id}`)])
  })

  it('keeps a feed without archives when startArchives is false', async () => {
    const { mock, session } = await connect()
    const simple = session.feed(undefined, { startArchives: false, maxItems: 5 })
    await simple.create({ title: 'Simple' })
    const first = await simple.addPost({ id: 'p1', content_text: '1' })
    expect(first.url).toBe(`${origin}/feed.json#p1`)
    await postMany(simple, 2, 7)
    expect(ids(read(mock, '/feed.json'))).toEqual(range(7, 3))
    expect(read(mock, '/feed.json')._pups).not.toHaveProperty('archive_url')
    expect(mock.state.files.has('/feed/feed.000000.json')).toBe(false)
    await simple.editPost('p5', { title: 'Five' })
    expect(read(mock, '/feed.json').items[2]).toMatchObject({ id: 'p5', title: 'Five' })
    await simple.deletePost('p7')
    expect(ids(read(mock, '/feed.json'))).toEqual(range(6, 3))

    // A client that starts archives takes the feed over with the items it still has.
    const archiving = session.feed(undefined, { maxItems: 5 })
    expect((await archiving.addPost({ id: 'p8', content_text: '8' })).url).toBe(`${origin}/feed/feed.000000.json#p8`)
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual(['p8', ...range(6, 3)])
    // From then on, the feed keeps its archives, also for clients that wouldn't start them.
    await simple.addPost({ id: 'p9', content_text: '9' })
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual(['p9', 'p8', ...range(6, 3)])
  })

  it('keeps an optional next_url of the feed file pointing to the newest archive', async () => {
    const { mock, session } = await connect()
    const feed = session.feed(undefined, { archiveSize: 2 })
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 1)
    writeRaw(mock, '/feed.json', { ...read(mock, '/feed.json'), next_url: `${origin}/feed/feed.000000.json` })
    await postMany(feed, 2, 3)
    expect(read(mock, '/feed.json').next_url).toBe(`${origin}/feed/feed.000001.json`)
    expect(read(mock, '/feed/feed.000001.json').next_url).toBe(`${origin}/feed/feed.000000.json`)
  })

  it('continues the chain of a handed-over feed without items', async () => {
    const { mock, session } = await connect()
    writeRaw(mock, '/feed.json', { version: 'https://jsonfeed.org/version/1.1', title: 'Old', next_url: 'https://old.example/page2.json', items: [], _pups: { pupsControlled: true } })
    await session.feed().addPost({ id: 'p1', content_text: 'Post 1' })
    expect(read(mock, '/feed/feed.000000.json').next_url).toBe('https://old.example/page2.json')
    expect(read(mock, '/feed.json').next_url).toBeUndefined()
  })
})

describe('editing and deleting', () => {
  it('edits posts in their archive, and in the feed file if they are there, and sets date_modified', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 35)

    const archived = await feed.editPost('p3', { title: 'Third', markdown: '*3*' })
    expect(archived.url).toBe(`${origin}/feed/feed.000000.json#p3`)
    const item = read(mock, '/feed/feed.000000.json').items.find(i => i.id == 'p3')!
    expect(item).toMatchObject({ title: 'Third', content_text: '*3*', _source: { markdown: '*3*' } })
    expect(item.date_modified).toBeDefined()
    expect(ids(read(mock, '/feed.json'))).not.toContain('p3')

    await feed.editPost('p35', current => ({ ...current, content_text: 'Changed' }))
    expect(read(mock, '/feed.json').items[0]).toMatchObject({ id: 'p35', content_text: 'Changed' })
    expect(read(mock, '/feed/feed.000001.json').items[0]).toMatchObject({ id: 'p35', content_text: 'Changed' })
    await feed.editPost('p34', { title: 'T' })
    await feed.editPost('p34', { title: null })
    expect(read(mock, '/feed.json').items[1]).not.toHaveProperty('title')
    expect(await errorCode(feed.editPost('p34', { content_text: null }))).toBe('invalid_request')
    expect(await errorCode(feed.editPost('nope', { title: 'x' }))).toBe('not_found')
  })

  it('deletes posts from their archive and fills the feed file up again', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 35)
    await feed.deletePost('p2')
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual([...range(20, 3), 'p1'])
    await feed.deletePost('p35')
    expect(ids(read(mock, '/feed/feed.000001.json'))).toEqual(range(34, 21))
    expect(ids(read(mock, '/feed.json'))).toEqual(range(34, 5))
    expect(await feed.getPost('p2')).toBeUndefined()
    expect(await errorCode(feed.deletePost('p2'))).toBe('not_found')
  })

  it('never rebalances archives, and keeps an empty archive in the chain', async () => {
    const { mock, session } = await connect()
    const feed = session.feed(undefined, { maxItems: 4, archiveSize: 2 })
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 6)
    await feed.deletePost('p3')
    await feed.deletePost('p4')
    const emptied = read(mock, '/feed/feed.000001.json')
    expect(emptied.items).toEqual([])
    expect(emptied.next_url).toBe(`${origin}/feed/feed.000000.json`)
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual(['p2', 'p1'])
    expect(ids(read(mock, '/feed/feed.000002.json'))).toEqual(['p6', 'p5'])
    expect(ids(read(mock, '/feed.json'))).toEqual(['p6', 'p5', 'p2', 'p1'])
    expect(await allIds(feed)).toEqual(['p6', 'p5', 'p2', 'p1'])
    // Deleting from the newest archive leaves it in place too; the next post goes into it.
    await feed.deletePost('p6')
    await feed.deletePost('p5')
    expect(read(mock, '/feed/feed.000002.json').items).toEqual([])
    expect((await feed.addPost({ id: 'p7', content_text: '7' })).url).toBe(`${origin}/feed/feed.000002.json#p7`)
    expect(await allIds(feed)).toEqual(['p7', 'p2', 'p1'])
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
    expect(await errorCode(feed.uploadMedia(png(), { folder: 'photos' }))).toBe('invalid_request')
    expect((await feed.uploadMedia(png(), { folder: 'media/covers' })).path).toMatch(/^\/feed\/media\/covers\/\d{4}\//)
  })
})

describe('feed settings', () => {
  it('updates the owner\'s fields and nothing else', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes', description: 'Old' })
    writeRaw(mock, '/feed.json', { ...read(mock, '/feed.json'), _unknown: { kept: true } })
    await feed.updateSettings({ title: 'New', description: null, _podcast: { explicit: false } })
    const doc = read(mock, '/feed.json')
    expect(doc).toMatchObject({ title: 'New', _podcast: { explicit: false }, _unknown: { kept: true } })
    expect(doc).not.toHaveProperty('description')
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
    const photos = session.feed('photos', { maxItems: 4, archiveSize: 2 })
    expect(photos).toMatchObject({ name: 'photos', path: '/feed/photos.json', directory: '/feed/photos/', url: `${origin}/feed/photos.json` })
    expect(() => session.feed('Photos')).toThrow(/not a valid feed name/)
    expect(() => session.feed('-x')).toThrow(/not a valid feed name/)
    expect(() => session.feed('images')).toThrow(/belong to the main feed/)
    expect(() => session.feed('media')).toThrow(/belong to the main feed/)
    await photos.create({ title: 'Photos', icon: png() })
    expect(read(mock, '/feed/photos.json').icon).toMatch(new RegExp(`^${origin}/feed/photos/images/icons/icon-[\\w-]+\\.png$`))
    for (let i = 1; i <= 5; i++) await photos.addPost({ id: `p${i}`, content_text: `${i}` })
    const doc = read(mock, '/feed/photos.json')
    expect(doc).toMatchObject({ feed_url: `${origin}/feed/photos.json`, home_page_url: `${origin}/`, _pups: { archive_url: `${origin}/feed/photos/feed.000002.json` } })
    expect(ids(doc)).toEqual(['p5', 'p4', 'p3', 'p2'])
    expect(ids(read(mock, '/feed/photos/feed.000000.json'))).toEqual(['p2', 'p1'])
    expect(read(mock, '/feed/photos/feed.000002.json')).toMatchObject({ next_url: `${origin}/feed/photos/feed.000001.json`, _pups: { updates_url: `${origin}/feed/photos.json` } })
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

describe('indexes', () => {
  const indexes = (doc: FeedDocument) => doc.items.map(item => item._pups?.index)
  /** Removes all indexes and counters, as a feed written before RFC-7 had indexes. */
  const unindex = (mock: Mock, path: string) => {
    const { next_index: _next, ...marker } = read(mock, path)._pups ?? {}
    const doc = read(mock, path)
    writeRaw(mock, path, { ...doc, _pups: marker, items: doc.items.map(({ _pups: _, ...item }) => item) })
  }

  it('numbers the posts from 0, in the archives and the feed file, with the counter in the newest archive', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    expect((await feed.addPost({ id: 'p1', content_text: '1' })).index).toBe(0)
    await postMany(feed, 2, 25)
    expect(indexes(read(mock, '/feed/feed.000000.json'))).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i))
    const newest = read(mock, '/feed/feed.000001.json')
    expect(indexes(newest)).toEqual([24, 23, 22, 21, 20])
    expect(newest._pups!.next_index).toBe(25)
    const main = read(mock, '/feed.json')
    expect(indexes(main)).toEqual(Array.from({ length: 25 }, (_, i) => 24 - i))
    expect(main._pups).not.toHaveProperty('next_index')
    expect((await feed.getPost('p7'))!.index).toBe(6)
  })

  it('never gives out an index again, and keeps it when the post is edited', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 3)
    await feed.deletePost('p3')
    expect((await feed.addPost({ id: 'p4', content_text: '4' })).index).toBe(3)
    await feed.editPost('p2', { title: 'Two', _pups: null } as never)
    await feed.editPost('p4', item => ({ id: item.id, content_text: 'replaced' }))
    expect(indexes(read(mock, '/feed/feed.000000.json'))).toEqual([3, 1, 0])
    expect(indexes(read(mock, '/feed.json'))).toEqual([3, 1, 0])
  })

  it('ignores an index in the input', async () => {
    const { session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    const result = await feed.addPost({ content_text: 'x', _pups: { index: 99, other: 1 } })
    expect(result.item._pups).toEqual({ index: 0, other: 1 })
  })

  it('keeps the counter in the feed file of a feed without archives', async () => {
    const { mock, session } = await connect()
    const simple = session.feed(undefined, { startArchives: false, maxItems: 3 })
    await simple.create({ title: 'Simple' })
    await postMany(simple, 1, 5)
    const main = read(mock, '/feed.json')
    expect(indexes(main)).toEqual([4, 3, 2])
    expect(main._pups!.next_index).toBe(5)
  })

  it('indexes a handed-over feed when it starts the archives', async () => {
    const { mock, session } = await connect()
    const old = range(25, 1).map(id => ({ id: `old-${id}`, content_text: id }))
    writeRaw(mock, '/feed.json', { version: 'https://jsonfeed.org/version/1.1', title: 'Old', items: old, _pups: { pupsControlled: true } })
    expect((await session.feed().addPost({ id: 'new', content_text: 'New' })).index).toBe(25)
    expect(indexes(read(mock, '/feed/feed.000000.json'))).toEqual(Array.from({ length: 20 }, (_, i) => 19 - i))
    expect(indexes(read(mock, '/feed/feed.000001.json'))).toEqual([25, 24, 23, 22, 21, 20])
    expect(read(mock, '/feed/feed.000001.json')._pups!.next_index).toBe(26)
    expect(indexes(read(mock, '/feed.json'))).toEqual(Array.from({ length: 26 }, (_, i) => 25 - i))
  })

  it('indexes an existing feed before posting to it: in the order of the archives, without gaps for deleted posts', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 25)
    await feed.deletePost('p2')
    for (const path of ['/feed.json', '/feed/feed.000000.json', '/feed/feed.000001.json']) unindex(mock, path)

    expect((await feed.addPost({ id: 'p26', content_text: '26' })).index).toBe(24)
    expect(indexes(read(mock, '/feed/feed.000000.json'))).toEqual(Array.from({ length: 19 }, (_, i) => 18 - i))
    expect(indexes(read(mock, '/feed/feed.000001.json'))).toEqual([24, 23, 22, 21, 20, 19])
    expect(read(mock, '/feed/feed.000001.json')._pups!.next_index).toBe(25)
    expect(indexes(read(mock, '/feed.json'))).toEqual(Array.from({ length: 25 }, (_, i) => 24 - i))
  })

  it('gives posts of clients without indexes theirs on the next post', async () => {
    const { mock, session } = await connect()
    const feed = session.feed()
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 2)
    // Another client, which doesn't know indexes, added two posts.
    const archive = read(mock, '/feed/feed.000000.json')
    writeRaw(mock, '/feed/feed.000000.json', { ...archive, items: [{ id: 'b', content_text: 'b' }, { id: 'a', content_text: 'a' }, ...archive.items] })
    expect((await feed.addPost({ id: 'p3', content_text: '3' })).index).toBe(4)
    expect(ids(read(mock, '/feed/feed.000000.json'))).toEqual(['p3', 'b', 'a', 'p2', 'p1'])
    expect(indexes(read(mock, '/feed/feed.000000.json'))).toEqual([4, 3, 2, 1, 0])
    expect(indexes(read(mock, '/feed.json'))).toEqual([4, 3, 2, 1, 0])
  })

  it('indexes a feed without posting', async () => {
    const { mock, session } = await connect()
    const feed = session.feed(undefined, { archiveSize: 2 })
    await feed.create({ title: 'Notes' })
    await postMany(feed, 1, 5)
    for (const path of ['/feed.json', '/feed/feed.000000.json', '/feed/feed.000001.json', '/feed/feed.000002.json']) unindex(mock, path)
    await feed.assignIndexes()
    expect(indexes(read(mock, '/feed/feed.000002.json'))).toEqual([4])
    expect(read(mock, '/feed/feed.000002.json')._pups!.next_index).toBe(5)
    expect(indexes(read(mock, '/feed/feed.000000.json'))).toEqual([1, 0])
    expect(indexes(read(mock, '/feed.json'))).toEqual([4, 3, 2, 1, 0])
    const etag = mock.state.files.get('/feed.json')!.etag
    await feed.assignIndexes()
    expect(mock.state.files.get('/feed.json')!.etag).toBe(etag)
  })

  it('gives every post a different index when two clients post at the same time', async () => {
    const { mock, session } = await connect()
    await session.feed().create({ title: 'Notes' })
    const a = session.feed(undefined, { maxAttempts: 50 })
    const b = session.feed(undefined, { maxAttempts: 50 })
    await Promise.all([postMany(a, 1, 15), (async () => {
      for (let i = 16; i <= 30; i++) await b.addPost({ id: `p${i}`, content_text: `Post ${i}` })
    })()])
    const archived = [0, 1].flatMap(n => indexes(read(mock, `/feed/feed.00000${n}.json`)))
    expect([...archived].sort((x, y) => x! - y!)).toEqual(Array.from({ length: 30 }, (_, i) => i))
  })
})
