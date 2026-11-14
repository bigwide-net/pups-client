import { PupsError } from './errors.js'

interface FileType {
  /** The type the server serves the file with. */
  served: string
  /** The `Content-Type` values accepted on upload. */
  accepted: readonly string[]
  /** Text types are UTF-8 and sent with `; charset=utf-8`. */
  text: boolean
}

const type = (served: string, accepted: string[] = [served], text = false): FileType => ({ served, accepted, text })
const text = (served: string, accepted?: string[]) => type(served, accepted, true)

/** The extension allowlist of RFC-6 ("File types"). The extension decides the type. */
export const fileTypes: Readonly<Record<string, FileType>> = {
  json: text('application/json', ['application/json', 'application/feed+json']),
  xml: text('application/xml', ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml']),
  opml: text('text/x-opml', ['text/x-opml', 'application/xml', 'text/xml']),
  md: text('text/markdown', ['text/markdown', 'text/x-markdown']),
  txt: text('text/plain'),
  csv: text('text/csv'),
  vcf: text('text/vcard', ['text/vcard', 'text/x-vcard']),
  svg: text('image/svg+xml'),
  png: type('image/png'),
  jpg: type('image/jpeg'),
  jpeg: type('image/jpeg'),
  gif: type('image/gif'),
  webp: type('image/webp'),
  avif: type('image/avif'),
  mp3: type('audio/mpeg'),
  m4a: type('audio/mp4', ['audio/mp4', 'audio/x-m4a']),
  ogg: type('audio/ogg', ['audio/ogg', 'audio/opus']),
  opus: type('audio/ogg', ['audio/ogg', 'audio/opus']),
  mp4: type('video/mp4', ['video/mp4', 'audio/mp4']),
  webm: type('video/webm', ['video/webm', 'audio/webm']),
}

/**
 * Extensions that are never accepted, anywhere in a file name (RFC-6 "Never accepted, anywhere").
 * The allowlist already excludes them; this list gives clear error messages and catches `feed.php.json`.
 */
export const blockedExtensions: ReadonlySet<string> = new Set([
  'html', 'htm', 'xhtml', 'js', 'mjs', 'css',
  'php', 'phtml', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phar', 'pht', 'phps', 'inc',
  'jsp', 'jspx', 'asp', 'aspx', 'cgi', 'pl', 'py', 'rb', 'sh', 'shtml', 'htaccess', 'htpasswd',
])

/** The media type without parameters, in lowercase. */
const essence = (contentType: string) => contentType.split(';')[0]!.trim().toLowerCase()

/**
 * Checks the file name of `path` against the allowlist and returns its file type.
 * @throws {PupsError} `unsupported_type`
 */
export function fileTypeOf(path: string): FileType & { extension: string } {
  const name = path.slice(path.lastIndexOf('/') + 1)
  // Apache's mod_mime treats every dot-separated part after the first as an extension.
  const extensions = name.toLowerCase().split('.').slice(1)
  const blocked = extensions.find(e => blockedExtensions.has(e))
  if (blocked) throw new PupsError('unsupported_type', `"${name}": files with ".${blocked}" in their name are never accepted (RFC-6, File types).`)
  const extension = extensions.at(-1)
  const fileType = extension ? fileTypes[extension] : undefined
  if (!extension || !fileType)
    throw new PupsError('unsupported_type', `"${name}": ${extension ? `".${extension}" is not` : 'a file without extension is not'} an allowed file type. Allowed: ${Object.keys(fileTypes).map(e => `.${e}`).join(', ')} (RFC-6, File types).`)
  return { ...fileType, extension }
}

/**
 * The `Content-Type` header to upload `path` with: `requested` if given and accepted for the extension,
 * otherwise the served type of the extension. Text types get `; charset=utf-8`.
 * @throws {PupsError} `unsupported_type`
 */
export function uploadContentType(path: string, requested?: string): string {
  const fileType = fileTypeOf(path)
  const chosen = requested ? essence(requested) : fileType.served
  if (!fileType.accepted.includes(chosen))
    throw new PupsError('unsupported_type', `Content-Type "${chosen}" is not accepted for ".${fileType.extension}" files. Accepted: ${fileType.accepted.join(', ')} (RFC-6, File types).`)
  return fileType.text ? `${chosen}; charset=utf-8` : chosen
}
