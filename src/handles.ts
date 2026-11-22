/**
 * Handles in text (bigwide.net RFC-11 "Handles"): `@` followed by a host name with at least two labels, e.g.
 * `@tim.example.com`. Not e-mail addresses (`tim@tim.example.com`), fediverse addresses (`@tim@social.example`),
 * names without a dot (`@foobar`) or paths (`@x.example/path`). A `/` directly between handles separates them:
 * `@a.example/@b.example` names both.
 */

const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?'
const HOST = `(?:${LABEL}\\.)+\\p{L}(?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?`
/** A handle, or several separated by `/`, with RFC-11's rules for the characters before and after. */
const HANDLES_RE = new RegExp(
  `(?:^|(?<=[\\s\\p{P}\\p{S}]))(?<![._\\-+/@])@${HOST}(?:/@${HOST})*(?![\\p{L}\\p{M}\\p{N}_\\-/@]|\\.[\\p{L}\\p{N}])`, 'gu')

/** Elements whose content is never shown. */
const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title', 'select', 'textarea', 'button'])
/** Elements whose content doesn't count for handles. */
const CODE_TAGS = new Set(['code', 'pre'])
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'])
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', commat: '@', sol: '/', period: '.' }

/** A host name as handles are compared: lowercase ASCII (IDNA). Undefined if it isn't a valid host. */
export function asciiHost(host: string): string | undefined {
  try {
    const url = new URL(`https://${host}/`)
    return url.hostname && url.pathname == '/' && !url.port ? url.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** The host of an account like `@alice.example.com`, in comparable form, or undefined. */
export function accountHost(account: unknown): string | undefined {
  const match = typeof account == 'string' ? /^@([^@\s/]+)$/u.exec(account.trim()) : null
  return match ? asciiHost(match[1]!) : undefined
}

/** The hosts of all handles in a plain text, in comparable form and in order, each once. */
export function findHandles(text: string): string[] {
  const hosts = [...text.matchAll(HANDLES_RE)].flatMap(m => m[0].split('/').map(h => asciiHost(h.slice(1))))
  return [...new Set(hosts.filter((h): h is string => !!h))]
}

const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
  if (name[0] != '#') return ENTITIES[name.toLowerCase()] ?? entity
  const code = name[1] == 'x' || name[1] == 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
})

/**
 * The visible text of an HTML fragment, with whitespace collapsed: without attribute values, comments and the
 * content of elements that are never shown. With `skipCode`, the content of `code` and `pre` is left out as well.
 * A small tokenizer, so that it works without a DOM; good enough for finding handles, not a sanitizer.
 */
export function visibleText(html: string, skipCode = false): string {
  let out = ''
  const hidden: string[] = []
  const tokens = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^>]*>?|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g
  for (const [token, rawTag, attributes] of html.matchAll(tokens)) {
    if (!rawTag) {
      if (token[0] != '<' || token == '<') {
        if (!hidden.length) out += decode(token)
      }
      continue
    }
    const tag = rawTag.toLowerCase()
    const closing = token[1] == '/'
    if (BLOCK_TAGS.has(tag)) out += ' '
    const hides = HIDDEN_TAGS.has(tag) || (skipCode && CODE_TAGS.has(tag))
    if (!hides) continue
    if (closing) {
      const at = hidden.lastIndexOf(tag)
      if (at >= 0) hidden.length = at
      out += ' '
    } else if (!VOID_TAGS.has(tag) && !attributes?.trimEnd().endsWith('/')) hidden.push(tag)
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** The parts of a JSON Feed item in which RFC-11 finds handles. */
export interface HandleSource {
  title?: unknown
  content_html?: unknown
  content_text?: unknown
  /** The Markdown of a `PostInput`, which becomes `content_text` if there is no other content. */
  markdown?: unknown
}

/**
 * The text of an item in which handles are found: the title, and the visible text of its HTML without code, or its
 * plain text (for a `PostInput`, its Markdown).
 */
export function handleText(item: HandleSource): string {
  const text = typeof item.content_text == 'string' ? item.content_text : typeof item.markdown == 'string' ? item.markdown : undefined
  const body = typeof item.content_html == 'string' ? visibleText(item.content_html, true) : text?.replace(/\s+/g, ' ').trim() ?? ''
  return `${typeof item.title == 'string' ? item.title : ''} ${body}`.trim()
}

/** The hosts of the handles in an item (RFC-11 "Finding handles in text"). */
export const itemHandles = (item: HandleSource) => findHandles(handleText(item))
