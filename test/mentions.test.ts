import { afterEach, describe, expect, it } from 'vitest'
import { PupsClient } from '../src/client.js'
import { isPupsError } from '../src/errors.js'
import { feedScopes, type FeedItem } from '../src/feed.js'
import { MENTION_REL, Mentions } from '../src/mentions.js'
import { MemoryTokenStore } from '../src/store/memory-store.js'
import { createMockServer } from './mock-server.js'

const origin = 'https://tim.example.com'
const RFC1 = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
const clients: PupsClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

type Handler = (request: Request) => Response | Promise<Response>

/** Other sites on the web: handlers by URL (without fragment), and every request they got. */
function createWeb() {
  const routes = new Map<string, Handler>()
  const requests: { method: string; url: string; body?: string; mode?: string }[] = []
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const fetchFn: typeof fetch = async (input, init = {}) => {
    const request = new Request(input, init)
    const body = request.method == 'POST' ? await request.clone().text() : undefined
    requests.push({ method: request.method, url: request.url, ...body !== undefined ? { body } : {}, ...init.mode ? { mode: init.mode } : {} })
    const handler = routes.get(request.url.replace(/#.*/, ''))
    if (!handler) throw new TypeError(`unknown URL ${request.url}`)
    return handler(new Request(request, { mode: init.mode == 'no-cors' ? 'no-cors' : undefined }))
  }
  const site = {
    routes, requests, json, fetch: fetchFn,
    /** A domain whose host-meta.json links its mention endpoint, which records what it receives. */
    receiver(host: string, answer: Handler = () => new Response(null, { status: 202 })) {
      const endpoint = `https://${host}/mention`
      routes.set(`https://${host}/.well-known/host-meta.json`, () => json({ links: [{ rel: MENTION_REL, href: endpoint }] }))
      routes.set(endpoint, answer)
      return endpoint
    },
    feed(url: string, items: Partial<FeedItem>[], extra: Record<string, unknown> = {}) {
      routes.set(url, () => json({ version: 'https://jsonfeed.org/version/1.1', title: 'Feed', items, ...extra }))
    },
    /** The webmentions an endpoint received, as [source, target]. */
    received(endpoint: string) {
      return requests.filter(r => r.method == 'POST' && r.url == endpoint).map(r => {
        const p = new URLSearchParams(r.body)
        return [p.get('source'), p.get('target')]
      })
    },
  }
  return site
}

const quick = (web: ReturnType<typeof createWeb>, retryDelays: number[] = []) => new Mentions({ fetch: web.fetch, retryDelays, visibilityDelays: [0, 0, 0] })
const by = (account: string, extra: Record<string, unknown> = {}) => ({ _source: { about: RFC1, accounts: { socialspec: account }, ...extra } })

describe('discovery and sending', () => {
  it('finds the mention endpoint in host-meta.json, and caches it, also when there is none', async () => {
    const web = createWeb()
    const endpoint = web.receiver('alice.example')
    web.routes.set('https://plain.example/.well-known/host-meta.json', () => web.json({ links: [{ rel: 'me', href: 'https://x.example/' }] }))
    web.routes.set('https://http.example/.well-known/host-meta.json', () => web.json({ links: [{ rel: MENTION_REL, href: 'http://http.example/mention' }] }))
    const m = quick(web)
    expect(await m.discover('@Alice.Example')).toBe(endpoint)
    expect(await m.discover('https://alice.example/')).toBe(endpoint)
    expect(await m.discover('plain.example')).toBeUndefined()
    expect(await m.discover('plain.example')).toBeUndefined()
    expect(await m.discover('http.example')).toBeUndefined()
    expect(await m.discover('gone.example')).toBeUndefined()
    expect(web.requests.filter(r => r.url.endsWith('host-meta.json')).map(r => new URL(r.url).host)).toEqual(['alice.example', 'plain.example', 'http.example', 'gone.example'])
  })

  it('sends form-encoded webmentions, retries only network errors, 5xx and 429, and reports the result', async () => {
    const web = createWeb()
    let calls = 0
    const flaky = web.receiver('flaky.example', () => ++calls < 3 ? new Response(null, { status: calls == 1 ? 503 : 429 }) : new Response(null, { status: 202 }))
    const strict = web.receiver('strict.example', () => web.json({ error: 'invalid_request', message: 'target is not served here' }, 400))
    const m = quick(web, [0, 0])
    expect(await m.notify('https://tim.example.com/feed/feed.000000.json#p1', '@flaky.example'))
      .toEqual({ account: '@flaky.example', kind: 'mention', target: 'https://flaky.example/', endpoint: flaky, status: 'accepted', httpStatus: 202 })
    expect(web.requests.find(r => r.url == flaky)!.body).toBe('source=https%3A%2F%2Ftim.example.com%2Ffeed%2Ffeed.000000.json%23p1&target=https%3A%2F%2Fflaky.example%2F')
    expect(calls).toBe(3)
    expect(await m.notify('https://tim.example.com/feed.json#p1', 'strict.example'))
      .toMatchObject({ status: 'rejected', httpStatus: 400, message: 'target is not served here' })
    expect(web.received(strict)).toHaveLength(1)
    expect(await m.notify('https://tim.example.com/feed.json#p1', '@none.example')).toMatchObject({ status: 'no-endpoint' })
  })

  it('sends to an endpoint without CORS without reading the answer', async () => {
    const web = createWeb()
    const endpoint = web.receiver('nocors.example', request => {
      if (request.mode != 'no-cors') throw new TypeError('Failed to fetch')
      return new Response(null, { status: 200 })
    })
    expect(await quick(web).notify('https://tim.example.com/feed.json#p1', '@nocors.example')).toMatchObject({ endpoint, status: 'unknown' })
    expect(web.requests.filter(r => r.url == endpoint).map(r => r.mode ?? 'cors')).toEqual(['cors', 'no-cors'])
  })
})

describe('notifyAll', () => {
  const source = `${origin}/files/feed/feed.000000.json#p1`

  it('notifies each named domain once, never the publisher, and the author of the answered item with a reply', async () => {
    const web = createWeb()
    const [alice, bob, carol] = ['alice.example', 'bob.example', 'carol.example'].map(h => web.receiver(h))
    web.feed('https://bob.example/feed.json', [{ id: 'b1', content_text: 'Hi', ...by('@bob.example') }])
    const item = {
      id: 'p1', title: 'With @alice.example', content_html: '<p>@bob.example and @tim.example.com, mail me: x@carol.example. <code>@carol.example</code></p>',
      ...by('@tim.example.com', { inReplyTo: 'https://bob.example/feed.json#b1' }),
    } as FeedItem
    const reports = await quick(web).notifyAll({ source, item, me: `${origin}/` })
    expect(reports.map(r => [r.account, r.kind, r.target, r.status])).toEqual([
      ['@bob.example', 'reply', 'https://bob.example/feed.json#b1', 'accepted'],
      ['@alice.example', 'mention', 'https://alice.example/', 'accepted'],
    ])
    expect([web.received(alice), web.received(bob), web.received(carol)]).toEqual([[[source, 'https://alice.example/']], [[source, 'https://bob.example/feed.json#b1']], []])
  })

  it('after an edit or delete, notifies everyone the old or the new version mentions', async () => {
    const web = createWeb()
    const [a, b] = ['a.example', 'b.example'].map(h => web.receiver(h))
    const previous = { id: 'p1', content_text: 'For @a.example' } as FeedItem
    await quick(web).notifyAll({ source, item: { id: 'p1', content_text: 'For @b.example' } as FeedItem, previous })
    await quick(web).notifyAll({ source, previous })
    expect([web.received(a).length, web.received(b).length]).toEqual([2, 1])
  })

  it('sends nothing for a reply to a feed that takes RFC-4 submissions: the RFC-4 server sends the mentions', async () => {
    const web = createWeb()
    const alice = web.receiver('alice.example')
    web.feed('https://rm.example/groups/g/posts.json', [{ id: 'g1', content_text: 'Hi', ...by('@alice.example') }], { _submissions: { url: 'https://rm.example/m', republish: 'full' } })
    const item = { id: 'c1', content_text: 'Agreed, @alice.example', ...by('@tim.example.com', { inReplyTo: 'https://rm.example/groups/g/posts.json#g1' }) } as FeedItem
    expect(await quick(web).notifyAll({ source, item })).toEqual([])
    expect(web.received(alice)).toEqual([])
  })

  it('finds the answered item in the archives, and takes the feed’s account only if the feed has no _submissions', async () => {
    const web = createWeb()
    const bob = web.receiver('bob.example')
    web.feed('https://bob.example/feed.json', [], { _source: { accounts: { socialspec: '@bob.example' } }, _archive: { archive_url: 'https://bob.example/feed/feed.000001.json' } })
    web.feed('https://bob.example/feed/feed.000001.json', [], { next_url: 'https://bob.example/feed/feed.000000.json' })
    web.feed('https://bob.example/feed/feed.000000.json', [{ id: 'old', content_text: 'Old' }])
    const item = { id: 'p1', content_text: 'Re', ...by('@tim.example.com', { inReplyTo: 'https://bob.example/feed.json#old' }) } as FeedItem
    expect((await quick(web).notifyAll({ source, item })).map(r => r.target)).toEqual(['https://bob.example/feed.json#old'])
    expect(web.received(bob)).toHaveLength(1)
  })

  it('sends no reply mention for an item with notifyReplies false, but still the mention by name', async () => {
    const web = createWeb()
    const bob = web.receiver('bob.example')
    web.feed('https://bob.example/feed.json', [
      { id: 'b1', content_text: 'Hi', ...by('@bob.example'), _commenting: { notifyReplies: false } },
      { id: 'b2', content_text: 'Hi again', ...by('@bob.example'), _commenting: { notifyReplies: true } },
    ])
    const reply = (to: string, content_text = 'Agreed') =>
      ({ id: 'p1', content_text, ...by('@tim.example.com', { inReplyTo: `https://bob.example/feed.json#${to}` }) }) as FeedItem
    const m = quick(web)
    expect(await m.notifyAll({ source, item: reply('b1') })).toEqual([])
    expect(await m.reply(source, 'https://bob.example/feed.json#b1')).toBeUndefined()
    expect((await m.notifyAll({ source, item: reply('b1', 'Did you see this, @bob.example?') })).map(r => [r.kind, r.target])).toEqual([['mention', 'https://bob.example/']])
    expect((await m.notifyAll({ source, item: reply('b2') })).map(r => [r.kind, r.target])).toEqual([['reply', 'https://bob.example/feed.json#b2']])
    expect(web.received(bob)).toEqual([[source, 'https://bob.example/'], [source, 'https://bob.example/feed.json#b2']])
    expect(await m.findItem('https://bob.example/feed.json#b1')).toMatchObject({ author: 'bob.example', notifyReplies: false })
  })

  it('notifies at most 20 accounts', async () => {
    const web = createWeb()
    const hosts = Array.from({ length: 25 }, (_, i) => `h${i}.example`)
    for (const h of hosts) web.receiver(h)
    const item = { id: 'p1', content_text: hosts.map(h => `@${h}`).join(' ') } as FeedItem
    expect((await quick(web).notifyAll({ source, item })).map(r => r.account)).toEqual(hosts.slice(0, 20).map(h => `@${h}`))
  })
})

describe('RFC-4 submissions', () => {
  it('submits to the endpoint in _submissions, and reads the status page', async () => {
    const web = createWeb()
    const endpoint = 'https://rm.example/groups/g/mention'
    web.feed('https://rm.example/groups/g/posts.json', [{ id: 'g1', content_text: 'Hi' }], { _submissions: { url: endpoint, republish: 'full' } })
    web.routes.set(endpoint, () => web.json({ status: 'waiting', guid: 'g1-x', statusUrl: 'https://rm.example/status/g1-x' }, 201, { Location: '/status/g1-x' }))
    web.routes.set('https://rm.example/status/g1-x', () => web.json({ status: 'success', pubUrl: 'https://rm.example/c.json#g1-x' }))
    const m = quick(web)
    const result = await m.submit(`${origin}/files/feed.json#c1`, 'https://rm.example/groups/g/posts.json#g1')
    expect(result).toEqual({ status: 'accepted', httpStatus: 201, location: 'https://rm.example/status/g1-x', endpoint, statusUrl: 'https://rm.example/status/g1-x', guid: 'g1-x' })
    expect(await m.submissionStatus(result.statusUrl!)).toEqual({ status: 'success', pubUrl: 'https://rm.example/c.json#g1-x' })
  })

  it('reports RFC-4 failures, and refuses feeds without _submissions', async () => {
    const web = createWeb()
    web.feed('https://rm.example/closed.json', [{ id: 'g1', content_text: 'Hi' }], { _submissions: { url: 'https://rm.example/m', republish: 'no' } })
    web.routes.set('https://rm.example/m', () => web.json({ error: 'comments-disabled', message: 'This feed accepts no comments' }, 400))
    web.feed('https://plain.example/feed.json', [{ id: 'p', content_text: 'Hi' }])
    const m = quick(web)
    expect(await m.submit('https://tim.example.com/feed.json#c1', 'https://rm.example/closed.json#g1')).toMatchObject({ status: 'rejected', code: 'comments-disabled' })
    const error = await m.submit('https://tim.example.com/feed.json#c1', 'https://plain.example/feed.json#p').catch(e => e)
    expect(isPupsError(error, 'unsupported')).toBe(true)
  })

  it('takes the _submissions of an RFC-7 archive from its feed file', async () => {
    const web = createWeb()
    web.feed('https://bob.example/feed.json', [], { _submissions: { url: 'https://bob.example/pups/comments', republish: 'no' } })
    web.feed('https://bob.example/feed/feed.000000.json', [{ id: 'b1', content_text: 'Old' }], { _archive: { updates_url: 'https://bob.example/feed.json' }, _submissions: { url: 'https://stale.example/m' } })
    expect((await quick(web).findItem('https://bob.example/feed/feed.000000.json#b1')).submissions).toEqual({ url: 'https://bob.example/pups/comments', republish: 'no' })
  })
})

describe('feeds that send mentions', () => {
  async function connect() {
    const mock = createMockServer({ maxUploadBytes: 1_000_000 })
    const web = createWeb()
    let stale = 0
    let publicReads = 0
    const fetchFn: typeof fetch = (input, init) => {
      const url = new URL(new Request(input, init).url)
      if (url.origin != origin) return web.fetch(input, init)
      // The public URLs of the feed files, served from storage; at first by a CDN that still has the old archive.
      if (url.pathname == '/feed.json' || url.pathname.startsWith('/feed/')) {
        publicReads++
        if (stale-- > 0) return Promise.resolve(new Response('{"version":"https://jsonfeed.org/version/1.1","items":[]}', { status: 200 }))
        return mock.fetch(`${origin}/files${url.pathname}`, init)
      }
      return mock.fetch(input, init)
    }
    const client = new PupsClient({ clientId: 'https://app.example/oauth/client.json', redirectUri: 'https://app.example/callback', store: new MemoryTokenStore(), fetch: fetchFn })
    clients.push(client)
    const pending = await client.createAuthorization('tim.example.com', { scopes: ['identify', ...feedScopes()] })
    const { session } = await client.completeAuthorization(mock.authorize(pending.url), pending)
    const feed = session!.feed(undefined, { mentions: new Mentions({ fetch: fetchFn, retryDelays: [], visibilityDelays: [0, 0, 0, 0] }) })
    await feed.create({ title: 'Notes' })
    return { mock, web, session: session!, feed, setStale: (n: number) => stale = n, publicReads: () => publicReads }
  }

  it('sends the mentions of a new post once it is visible, with its archive URL as source', async () => {
    const { web, feed, setStale, publicReads } = await connect()
    const alice = web.receiver('alice.example')
    setStale(2)
    const post = await feed.addPost({ id: 'p1', content_html: '<p>Hello <a href="https://alice.example/">@alice.example</a></p>' })
    expect(await post.mentions).toEqual([{ account: '@alice.example', kind: 'mention', target: 'https://alice.example/', endpoint: alice, status: 'accepted', httpStatus: 202 }])
    expect(web.received(alice)).toEqual([[`${origin}/feed/feed.000000.json#p1`, 'https://alice.example/']])
    expect(publicReads()).toBe(3) // twice the old archive, then the new one
    expect((await feed.addPost({ content_text: 'Nobody' })).mentions).toBeUndefined()
  })

  it('notifies the old and new accounts after an edit, and the old ones after a delete', async () => {
    const { web, feed } = await connect()
    const [a, b] = ['a.example', 'b.example'].map(h => web.receiver(h))
    await (await feed.addPost({ id: 'p1', content_text: 'For @a.example' })).mentions
    await (await feed.editPost('p1', { content_text: 'For @b.example' })).mentions
    await (await feed.deletePost('p1')).mentions
    expect([web.received(a).length, web.received(b).length]).toEqual([2, 2])
  })

  it('sends again on request, and submits replies to RFC-4 feeds', async () => {
    const { web, feed } = await connect()
    const a = web.receiver('a.example')
    const endpoint = 'https://rm.example/m'
    web.feed('https://rm.example/posts.json', [{ id: 'g1', content_text: 'Hi' }], { _submissions: { url: endpoint, republish: 'full' } })
    web.routes.set(endpoint, () => web.json({ status: 'waiting', guid: 'x' }, 201, { Location: 'https://rm.example/status/x' }))
    const post = await feed.addPost({ id: 'c1', content_text: 'Agreed, @a.example', _source: { inReplyTo: 'https://rm.example/posts.json#g1' } })
    expect(await post.mentions).toEqual([])
    expect(await feed.submit('c1')).toMatchObject({ status: 'accepted', statusUrl: 'https://rm.example/status/x' })
    expect(web.received(endpoint)).toEqual([[`${origin}/feed/feed.000000.json#c1`, 'https://rm.example/posts.json#g1']])
    await feed.addPost({ id: 'p2', content_text: 'Hi @a.example' })
    expect((await feed.sendMentions('p2')).map(r => r.status)).toEqual(['accepted'])
    expect(web.received(a).length).toBeGreaterThanOrEqual(1)
  })
})

describe('asking before sending', () => {
  it('plans the mentions of a post without sending or discovering anything', async () => {
    const web = createWeb()
    const [a] = ['a.example', 'b.example'].map(h => web.receiver(h))
    web.feed('https://bob.example/feed.json', [{ id: 'b1', content_text: 'Hi', ...by('@bob.example') }])
    const m = new Mentions({ fetch: web.fetch, me: `${origin}/` })
    const post = { markdown: 'Thanks @a.example, @b.example, @none.example and @tim.example.com', _source: { inReplyTo: 'https://bob.example/feed.json#b1' } }
    expect(await m.plan({ item: post })).toEqual([
      { account: '@bob.example', kind: 'reply', target: 'https://bob.example/feed.json#b1' },
      { account: '@a.example', kind: 'mention', target: 'https://a.example/' },
      { account: '@b.example', kind: 'mention', target: 'https://b.example/' },
      { account: '@none.example', kind: 'mention', target: 'https://none.example/' },
    ])
    expect(web.requests.map(r => r.url)).toEqual(['https://bob.example/feed.json'])
    // With discover, only the accounts that accept mentions, with their endpoints.
    const planned = await m.plan({ item: post }, { discover: true })
    expect(planned.map(p => [p.account, p.endpoint])).toEqual([['@a.example', a], ['@b.example', 'https://b.example/mention']])
    expect(web.requests.filter(r => r.method == 'POST')).toEqual([])
    expect((await m.sendPlanned('https://tim.example.com/feed.json#p1', planned.slice(0, 1))).map(r => [r.account, r.status])).toEqual([['@a.example', 'accepted']])
  })
})

describe('feeds that ask before sending', () => {
  async function connect(feedMentions: boolean) {
    const mock = createMockServer({ maxUploadBytes: 1_000_000 })
    const web = createWeb()
    const fetchFn: typeof fetch = (input, init) => {
      const url = new URL(new Request(input, init).url)
      if (url.origin != origin) return web.fetch(input, init)
      if (url.pathname == '/feed.json' || url.pathname.startsWith('/feed/')) return mock.fetch(`${origin}/files${url.pathname}`, init)
      return mock.fetch(input, init)
    }
    const client = new PupsClient({ clientId: 'https://app.example/oauth/client.json', redirectUri: 'https://app.example/callback', store: new MemoryTokenStore(), fetch: fetchFn })
    clients.push(client)
    const pending = await client.createAuthorization('tim.example.com', { scopes: ['identify', ...feedScopes()] })
    const { session } = await client.completeAuthorization(mock.authorize(pending.url), pending)
    const mentions = new Mentions({ fetch: fetchFn, retryDelays: [], visibilityDelays: [0], me: session!.me })
    const feed = session!.feed(undefined, { mentions: feedMentions ? mentions : false })
    await feed.create({ title: 'Notes' })
    return { web, feed, mentions }
  }

  it('sends only the confirmed mentions, or none', async () => {
    const { web, feed } = await connect(false)
    const [a, b] = ['a.example', 'b.example'].map(h => web.receiver(h))
    const input = { id: 'p1', content_text: 'For @a.example and @b.example and @tim.example.com' }
    const planned = await feed.planMentions(input)
    expect(planned.map(p => p.account)).toEqual(['@a.example', '@b.example'])
    // The author unticks @b.example.
    const post = await feed.addPost(input, { mentions: planned.filter(p => p.account != '@b.example') })
    expect((await post.mentions)!.map(r => [r.account, r.status])).toEqual([['@a.example', 'accepted']])
    expect([web.received(a), web.received(b)]).toEqual([[[`${origin}/feed/feed.000000.json#p1`, 'https://a.example/']], []])
    // Declined, or nothing confirmed: posted without mentions.
    expect((await feed.addPost({ content_text: 'Again @a.example' }, { mentions: false })).mentions).toBeUndefined()
    expect((await feed.addPost({ content_text: 'Again @a.example' }, { mentions: [] })).mentions).toBeUndefined()
    expect((await feed.addPost({ content_text: 'Again @a.example' })).mentions).toBeUndefined()
    expect(web.received(a)).toHaveLength(1)
  })

  it('overrides the feed’s option per write, also for edits and deletes', async () => {
    const { web, feed } = await connect(true)
    const a = web.receiver('a.example')
    const post = await feed.addPost({ id: 'p1', content_text: 'For @a.example' }, { mentions: false })
    expect(post.mentions).toBeUndefined()
    const old = post.item
    const planned = await feed.planMentions({ ...old, content_text: 'For nobody' }, { previous: old })
    expect(planned.map(p => p.account)).toEqual(['@a.example'])
    await (await feed.editPost('p1', { content_text: 'For nobody' }, { mentions: planned })).mentions
    expect((await feed.deletePost('p1', { mentions: false })).mentions).toBeUndefined()
    expect(web.received(a)).toHaveLength(1)
  })
})
