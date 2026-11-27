import { afterEach, describe, expect, it } from 'vitest'
import { PupsClient } from '../src/client.js'
import { commentFeedPath } from '../src/comments.js'
import { isPupsError } from '../src/errors.js'
import type { FeedItem } from '../src/feed.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import { createMockServer } from './mock-server.js'

const origin = 'https://tim.example.com'
const clients: PupsClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

const group = 'https://rm.example.org/groups/twowaves/posts.json'
const inReplyTo = (item: FeedItem) => (item._source as { inReplyTo?: unknown }).inReplyTo
const endpoint = 'https://rm.example.org/groups/twowaves/mention'
const comments = 'https://rm.example.org/groups/twowaves/comments/a8Kd03XpQz.json'

/** A session with the `appdata` scope, and a discussion group on rm.example.org that records the webmentions it gets. */
async function connect() {
  const mock = createMockServer({ maxUploadBytes: 10_000 })
  const received: [string | null, string | null][] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = request.url.replace(/#.*/, '')
    if (url.startsWith(origin)) return mock.fetch(input, init)
    if (url == group) return json({ version: 'https://jsonfeed.org/version/1.1', title: 'Group', items: [{ id: 'a8Kd03XpQz', content_text: 'Hi' }], _submissions: { url: endpoint, republish: 'full' } })
    if (url == comments) return json({ version: 'https://jsonfeed.org/version/1.1', title: 'Comments on “Hi”', items: [
      { id: 'c1', title: 'Agreed', content_text: 'Yes', _source: { inReplyTo: `${group}#a8Kd03XpQz` } },
      { id: 'c2', content_text: 'No', _source: { inReplyTo: { value: `${group}#a8Kd03XpQz` } } },
    ] })
    if (url == 'https://alice.example.com/feed.json') return json({ version: 'https://jsonfeed.org/version/1.1', title: 'Blog', items: [{ id: 'post-42', content_text: 'Hi' }], _submissions: { url: endpoint, republish: 'full' } })
    if (url == endpoint) {
      const params = new URLSearchParams(await request.text())
      received.push([params.get('source'), params.get('target')])
      return json({ status: 'waiting', guid: `g-${received.length}` }, 201)
    }
    throw new TypeError(`unknown URL ${request.url}`)
  }
  const client = new PupsClient({ clientId: 'https://app.example/oauth/client.json', redirectUri: 'https://app.example/callback', store: new MemoryTokenStore(), fetch: fetchFn })
  clients.push(client)
  const pending = await client.createAuthorization('tim.example.com', { scopes: ['identify', 'appdata'] })
  const { session } = await client.completeAuthorization(mock.authorize(pending.url), pending)
  const read = (path: string) => JSON.parse(new TextDecoder().decode(mock.state.files.get(path)!.body))
  return { mock, session: session!, received, read }
}

describe('comment feed names', () => {
  it('hash the target host and the hour in UTC, as in the RFC examples', async () => {
    expect(await commentFeedPath(`${group}#a8Kd03XpQz`, '2026-11-04T10:20:00Z')).toBe('b7b/8ec59ab09c61ab7b.json')
    expect(await commentFeedPath('https://alice.example.com/feed.json#post-42', '2026-11-04T10:20:00Z')).toBe('968/b2f08b37d2afa968.json')
    // Same site and hour: the same file, whatever the path, the minute or the time zone.
    expect(await commentFeedPath('https://RM.example.org:443/other.json', '2026-11-04T11:59:59+01:00')).toBe('b7b/8ec59ab09c61ab7b.json')
    expect(await commentFeedPath(`${group}#a8Kd03XpQz`, '2026-11-04T11:00:00Z')).not.toBe('b7b/8ec59ab09c61ab7b.json')
    expect(await commentFeedPath('https://bücher.example/feed.json', '2026-11-04T10:00:00Z')).toBe(await commentFeedPath('https://xn--bcher-kva.example/feed.json', '2026-11-04T10:00:00Z'))
  })

  it('refuse targets that are no http(s) URLs, and invalid dates', async () => {
    for (const [target, date] of [['mailto:a@b.example', '2026-11-04T10:00:00Z'], ['not a url', '2026-11-04T10:00:00Z'], [group, 'yesterday']])
      expect(isPupsError(await commentFeedPath(target, date).catch(e => e), 'invalid_request')).toBe(true)
  })
})

describe('comments', () => {
  it('go into a comment feed in the app directory, never into the main feed, and are submitted from there', async () => {
    const { mock, session, received, read } = await connect()
    const result = await session.comments.post({ target: `${group}#a8Kd03XpQz`, markdown: 'Agreed, but discovery is hard.' })
    const path = await session.comments.pathFor(group, result.item.date_published!)
    expect(result.path).toBe(path)
    expect(path).toMatch(/^\/appdata\/app\.example\/comments\/([0-9a-f]{3})\/[0-9a-f]{13}\1\.json$/)
    expect(result.source).toBe(`${origin}/files${path}#${result.item.id}`)
    expect(read(path)).toEqual({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'Comments by tim.example.com',
      home_page_url: 'https://tim.example.com/',
      feed_url: `${origin}/files${path}`,
      _source: { about: expect.any(String), accounts: { socialspec: '@tim.example.com' } },
      items: [result.item],
    })
    // inReplyTo names the target's feed, with the title read from it (RFC-1).
    expect(result.item).toMatchObject({ content_text: 'Agreed, but discovery is hard.', _source: {
      inReplyTo: { value: `${group}#a8Kd03XpQz`, feedUrl: group, feedTitle: 'Group' }, markdown: 'Agreed, but discovery is hard.' } })
    expect(result.item.id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(mock.state.files.has('/feed.json')).toBe(false)
    expect(received).toEqual([[result.source, `${group}#a8Kd03XpQz`]])
    expect(result.submission).toMatchObject({ status: 'accepted', endpoint, guid: 'g-1' })
  })

  it('share a file per target site and hour: newer comments first; other sites get their own file', async () => {
    const { session, read } = await connect()
    const first = await session.comments.post({ target: `${group}#a8Kd03XpQz`, content_text: 'One' })
    const second = await session.comments.post({ target: group, title: 'A new topic', content_text: 'Two' })
    const other = await session.comments.post({ target: 'https://alice.example.com/feed.json#post-42', content_text: 'Three' })
    // Unless the hour changed in between, the first two share a file.
    if (first.path == second.path) expect(read(first.path).items.map((i: { id: string }) => i.id)).toEqual([second.item.id, first.item.id])
    expect(other.path).not.toBe(first.path)
    expect(read(other.path).items).toHaveLength(1)
  })

  it('can be read, edited and submitted again with the same source', async () => {
    const { session, received, read } = await connect()
    const posted = await session.comments.post({ target: `${group}#a8Kd03XpQz`, content_text: 'Frist' })
    expect((await session.comments.get(posted.source))!.item).toEqual(posted.item)
    const edited = await session.comments.edit(posted.source, { content_text: 'First', _source: { about: 'x', inReplyTo: 'https://evil.example/feed.json#1' } })
    expect(edited.source).toBe(posted.source)
    expect(edited.item).toMatchObject({ id: posted.item.id, date_published: posted.item.date_published, content_text: 'First', _source: { inReplyTo: inReplyTo(posted.item) } })
    expect(edited.item.date_modified).toBeDefined()
    expect(read(posted.path).items).toEqual([edited.item])
    expect(received.map(([source, target]) => [source, target])).toEqual([[posted.source, `${group}#a8Kd03XpQz`], [posted.source, `${group}#a8Kd03XpQz`]])
  })

  it('are deleted from their file, which goes once it is empty, and the deletion is submitted', async () => {
    const { mock, session, received, read } = await connect()
    const a = await session.comments.post({ target: `${group}#a8Kd03XpQz`, content_text: 'A' })
    const b = await session.comments.post({ target: `${group}#a8Kd03XpQz`, content_text: 'B' }, { submit: false })
    expect(received).toHaveLength(1)
    await session.comments.delete(b.source, { submit: false })
    if (a.path == b.path) expect(read(a.path).items).toEqual([a.item])
    const deleted = await session.comments.delete(a.source)
    expect(deleted.item).toEqual(a.item)
    expect(mock.state.files.has(a.path)).toBe(false)
    expect(received.at(-1)).toEqual([a.source, `${group}#a8Kd03XpQz`])
    expect(await session.comments.get(a.source)).toBeUndefined()
    expect(isPupsError(await session.comments.delete(a.source).catch(e => e), 'not_found')).toBe(true)
  })

  it('name the answered comment by its title, or not at all, and take the title from the app', async () => {
    const { session, received } = await connect()
    const titled = await session.comments.post({ target: `${comments}#c1`, content_text: 'A' }, { submit: false })
    expect(inReplyTo(titled.item)).toEqual({ value: `${comments}#c1`, feedUrl: comments, feedTitle: 'Agreed' })
    const untitled = await session.comments.post({ target: `${comments}#c2`, content_text: 'B' }, { submit: false })
    expect(inReplyTo(untitled.item)).toEqual({ value: `${comments}#c2`, feedUrl: comments })
    const given = await session.comments.post({ target: `${group}#a8Kd03XpQz`, inReplyToTitle: 'Two Waves', content_text: 'C' })
    expect(inReplyTo(given.item)).toEqual({ value: `${group}#a8Kd03XpQz`, feedUrl: group, feedTitle: 'Two Waves' })
    const none = await session.comments.post({ target: `${group}#a8Kd03XpQz`, inReplyToTitle: null, content_text: 'D' }, { submit: false })
    expect(inReplyTo(none.item)).toEqual({ value: `${group}#a8Kd03XpQz`, feedUrl: group })
    const unknown = await session.comments.post({ target: 'https://gone.example/feed.json#1', content_text: 'E' }, { submit: false })
    expect(inReplyTo(unknown.item)).toEqual({ value: 'https://gone.example/feed.json#1', feedUrl: 'https://gone.example/feed.json' })
    expect(received).toEqual([[given.source, `${group}#a8Kd03XpQz`]])
  })

  it('refuse sources outside the app\'s comment feeds', async () => {
    const { session } = await connect()
    for (const source of [`${origin}/files/feed.json#1`, `${origin}/files/appdata/app.example/notes.json#1`, 'https://other.example/appdata/app.example/comments/def/0123456789abcdef.json#1'])
      expect(isPupsError(await session.comments.get(source).catch(e => e), 'invalid_request')).toBe(true)
  })
})
