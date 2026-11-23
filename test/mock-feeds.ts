/**
 * Kept feeds for the mock server (RFC-7 "Kept feeds"): the server keeps the RFC-13 archives of feed files with the
 * `_pups` marker. A compact version of what pups-php does: PUT of a feed file applies its items to the archives,
 * POST adds, replaces or deletes a single item, and apps can't write archives.
 */
type Doc = Record<string, any>
type Item = Record<string, any>

const ARCHIVE_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md'
const FEED_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md'
const MANAGED = ['version', 'home_page_url', 'feed_url', 'user_comment', 'next_url', 'items', '_archive']
const FEED_ITEMS = 30
const ARCHIVE_SIZE = 20

export interface KeptEnv {
  read(path: string): Doc | undefined
  write(path: string, doc: Doc): void
  publicUrl(path: string): string
  me: string
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

export const isFeedPath = (path: string) => path == '/feed.json' || /^\/feed\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.json$/.test(path) && !/^\/feed\/(images|media|comments)\.json$/.test(path)
export const archiveOwner = (path: string) => {
  const m = /^(\/.+)\/feed\.\d{6,}\.json$/.exec(path)
  return m && isFeedPath(`${m[1]}.json`) ? `${m[1]}.json` : undefined
}
export const isKept = (doc: unknown): doc is Doc => (doc as Doc | undefined)?._pups?.pupsControlled === true
export const isFeed = (doc: unknown): doc is Doc =>
  typeof doc == 'object' && doc !== null && typeof (doc as Doc).version == 'string' && (doc as Doc).version.startsWith('https://jsonfeed.org/version/1') && Array.isArray((doc as Doc).items)

const indexOf = (item: Item | undefined): number | undefined => {
  const i = item?._archive?.index
  return Number.isSafeInteger(i) && i >= 0 ? i : undefined
}
const setIndex = (item: Item, index: number | undefined) => {
  const { index: _old, ...rest } = item._archive ?? {}
  if (index === undefined && !Object.keys(rest).length) delete item._archive
  else item._archive = index === undefined ? rest : { ...rest, index }
}
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) =>
  x && typeof x == 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x)
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function checkItem(item: unknown): Item {
  if (typeof item != 'object' || item === null || Array.isArray(item)) throw new HttpError(400, 'invalid_request')
  const it = item as Item
  if (it.id === undefined) return checkItem({ id: `p-${Math.random().toString(36).slice(2, 18)}`, ...it })
  if (typeof it.id != 'string' || !it.id) throw new HttpError(400, 'invalid_request')
  if (typeof it.content_html != 'string' && typeof it.content_text != 'string') throw new HttpError(400, 'invalid_request')
  return it
}

export class KeptFeed {
  doc: Doc
  #window: Item[]
  #size = ARCHIVE_SIZE
  #newest?: number
  #next = 0
  #oldChain?: string
  #archives = new Map<number, Doc | undefined>()
  #changed = new Set<number>()

  constructor(private env: KeptEnv, readonly path: string, stored?: Doc) {
    this.doc = stored ?? { version: 'https://jsonfeed.org/version/1.1', items: [] }
    const m = new RegExp(`^${this.#archiveUrl(0).replace('000000.json', '')}(\\d{6,})\\.json$`).exec(this.doc._archive?.archive_url ?? '')
    this.#window = this.doc.items.filter((i: unknown) => typeof i == 'object' && i)
    if (m) {
      this.#newest = Number(m[1])
      this.#size = this.doc._archive.archive_size ?? ARCHIVE_SIZE
      this.#next = this.#archive(this.#newest)?._archive?.next_index ?? 0
    } else this.#start()
  }

  #start() {
    const items: Item[] = this.#window
    let next = Math.max(this.doc._archive?.next_index ?? 0, ...items.map(i => (indexOf(i) ?? -1) + 1))
    for (let i = items.length - 1; i >= 0; i--) if (indexOf(items[i]) === undefined) setIndex(items[i]!, next++)
    this.#next = next
    this.#oldChain = typeof this.doc.next_url == 'string' ? this.doc.next_url : undefined
    const oldest = [...items].reverse()
    for (let n = 0; n * this.#size < oldest.length; n++) this.#create(n, oldest.slice(n * this.#size, (n + 1) * this.#size).reverse())
  }

  #archivePath(n: number) {
    return `${this.path.slice(0, -5)}/feed.${String(n).padStart(6, '0')}.json`
  }

  #archiveUrl(n: number) {
    return this.env.publicUrl(this.#archivePath(n))
  }

  address(n: number, id: string) {
    return `${this.#archiveUrl(n)}#${encodeURIComponent(id)}`
  }

  #archive(n: number): Doc | undefined {
    if (!this.#archives.has(n)) this.#archives.set(n, this.env.read(this.#archivePath(n)))
    return this.#archives.get(n)
  }

  #create(n: number, items: Item[]): Doc {
    const fields = Object.fromEntries(Object.entries(this.doc).filter(([k]) => ![...MANAGED, 'hubs', 'author', '_pups', '_submissions'].includes(k)))
    const a: Doc = structuredClone(fields)
    if (a._podcast) delete a._podcast.liveItems
    Object.assign(a, {
      version: 'https://jsonfeed.org/version/1.1',
      home_page_url: this.env.me,
      feed_url: this.#archiveUrl(n),
      user_comment: `This is an archive of ${this.env.publicUrl(this.path)}.`,
      ...n ? { next_url: this.#archiveUrl(n - 1) } : this.#oldChain ? { next_url: this.#oldChain } : {},
      _pups: { about: FEED_SPEC, pupsControlled: true },
      _archive: {},
      items,
    })
    if (this.#newest !== undefined && n > this.#newest && this.#archive(this.#newest)) this.#changed.add(this.#newest)
    this.#newest = Math.max(this.#newest ?? n, n)
    this.#changed.add(n)
    this.#archives.set(n, a)
    return a
  }

  find(id: string, index: number | undefined, everywhere = false): [number, number] | undefined {
    if (this.#newest === undefined) return
    index ??= indexOf(this.#window.find(i => i.id == id))
    const at = (n: number) => this.#archive(n)?.items.findIndex((i: Item) => i.id == id && (index === undefined || indexOf(i) == index)) ?? -1
    const order = index === undefined
      ? Array.from({ length: everywhere ? this.#newest + 1 : 1 }, (_, k) => this.#newest! - k)
      : Array.from({ length: this.#newest + 1 }, (_, k) => this.#newest! - k)
    for (const n of order) {
      const p = at(n)
      if (p >= 0) return [n, p]
    }
    return
  }

  put(raw: unknown, missing = 404): { item: Item; address: string; created: boolean; changed: boolean } {
    const item = checkItem(raw)
    const index = indexOf(item)
    const found = this.find(item.id, index)
    if (!found && index !== undefined) throw new HttpError(missing, missing == 404 ? 'not_found' : 'conflict')
    if (found) {
      const [n, p] = found
      const archive = this.#archive(n)!
      const old = archive.items[p]
      setIndex(item, indexOf(old))
      if (typeof item.date_published != 'string' && old.date_published) item.date_published = old.date_published
      const probe = { ...item, ...item.date_modified === undefined && old.date_modified !== undefined ? { date_modified: old.date_modified } : {} }
      if (canonical(probe) == canonical(old)) return { item: old, address: this.address(n, item.id), created: false, changed: false }
      if (item.date_modified === old.date_modified) item.date_modified = now()
      archive.items[p] = item
      this.#changed.add(n)
      return { item, address: this.address(n, item.id), created: false, changed: true }
    }
    if (typeof item.date_published != 'string') item.date_published = now()
    setIndex(item, this.#next++)
    const newest = this.#newest === undefined ? undefined : this.#archive(this.#newest) ?? this.#create(this.#newest, [])
    if (newest && newest.items.length < this.#size) {
      newest.items.unshift(item)
      this.#changed.add(this.#newest!)
    } else this.#create(this.#newest === undefined ? 0 : this.#newest + 1, [item])
    return { item, address: this.address(this.#newest!, item.id), created: true, changed: true }
  }

  delete(id: string, index?: number): { item: Item; address: string } | undefined {
    const found = this.find(id, index, true)
    if (!found) return
    const [item] = this.#archive(found[0])!.items.splice(found[1], 1)
    this.#changed.add(found[0])
    return { item, address: this.address(found[0], id) }
  }

  apply(body: Doc) {
    const before = new Map(this.#window.map(i => [i.id as string, i]))
    const seen = new Set<string>()
    const put: Item[] = []
    for (const item of body.items) {
      if (typeof item?.id == 'string') {
        if (seen.has(item.id)) throw new HttpError(400, 'invalid_request')
        seen.add(item.id)
      }
      if (!before.has(item?.id) || canonical(item) != canonical(before.get(item.id))) put.push(item)
    }
    this.doc = { ...Object.fromEntries(Object.entries(body).filter(([k]) => !MANAGED.includes(k))), _archive: this.doc._archive }
    for (const [id, item] of before) if (!seen.has(id)) this.delete(id, indexOf(item))
    for (const item of put.reverse()) this.put(item, 409)
  }

  commit(): Doc {
    for (const n of [...this.#changed].sort((a, b) => a - b)) {
      const a = this.#archive(n)!
      const { next_index: _, ...fields } = a._archive ?? {}
      a._archive = { about: ARCHIVE_SPEC, updates_url: this.env.publicUrl(this.path), number: n, ...fields, ...n == this.#newest ? { next_index: this.#next } : {} }
      this.env.write(this.#archivePath(n), a)
    }
    this.#changed.clear()
    const { version: _v, items: _i, author, next_url: _n, _archive: _a, ...fields } = this.doc
    const items: Item[] = []
    for (let n = this.#newest ?? -1; n >= 0 && items.length < FEED_ITEMS; n--)
      for (const item of this.#archive(n)?.items ?? []) if (items.length < FEED_ITEMS) items.push(item)
    const doc: Doc = {
      version: 'https://jsonfeed.org/version/1.1',
      ...fields,
      ...author && !fields.authors ? { authors: [author] } : {},
      home_page_url: this.env.me,
      feed_url: this.env.publicUrl(this.path),
      user_comment: 'This feed is kept by a Personal Upload Server (PUPS).',
      _pups: { about: FEED_SPEC, ...fields._pups, pupsControlled: true },
      ...this.#newest === undefined
        ? { ...this.#oldChain ? { next_url: this.#oldChain } : {}, ...this.#next ? { _archive: { about: ARCHIVE_SPEC, next_index: this.#next } } : {} }
        : { _archive: { about: ARCHIVE_SPEC, archive_url: this.#archiveUrl(this.#newest), archive_template: this.#archiveUrl(0).replace('000000.json', '{number}.json'), archive_size: this.#size } },
      items,
    }
    this.env.write(this.path, doc)
    return doc
  }
}
