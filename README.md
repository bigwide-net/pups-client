# pups-client

The reference client for **Personal Upload Servers** (PUPS, [bigwide.net RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md)): sign a user in with their own domain, and write files to it.

- **Browser library** in TypeScript, without runtime dependencies.
- **Command line tool** `pups`, for uploading from a terminal or a script.

PUPS lets any app write files to a user's domain, knowing nothing but the domain. The user approves the app at their own server with standard OAuth, and everything the app writes is published as static files, except in the private areas that only the owner's apps can read.

> Status: 0.1, implements RFC-6 `spec_version` 0.1. The RFC is a draft, so the API may still change.

## Command line tool

### Setup, once per client domain

The CLI signs in as an OAuth client whose identity is a domain you control, e.g. `tim.example.app`. The PUPS server fetches the client's metadata document from that domain, so it must be public and served over HTTPS.

```sh
npm install -g pups-client          # or: npx pups-client …

pups client-metadata tim.example.app > pups-cli.json
# Publish pups-cli.json at https://tim.example.app/pups-cli.json (as application/json), then:
pups check-client tim.example.app
```

The document lists `http://127.0.0.1/callback` as its redirect URI. RFC-6 ignores the port of loopback redirects, so the CLI can listen on any free port.

### Sign in and upload

```sh
pups login tjansen.de --client tim.example.app
# Opens the browser at tjansen.de's PUPS server. After you approve:
# Signed in as https://tjansen.de/

pups whoami
pups put photo.jpg notes.md                    # → /appdata/tim.example.app/photo.jpg, …
pups put data.json --to backup/                # → /appdata/tim.example.app/backup/data.json
echo '# Hi' | pups put - --to hello.md         # from stdin
pups get hello.md
pups rm hello.md
pups logout                                    # forgets the credentials and revokes the grant
```

Paths without a leading `/` are in the app's own directory, `/appdata/<client-domain>/`. To write elsewhere, ask for a well-known path the server declares:

```sh
pups login tjansen.de -c tim.example.app -s appdata -s write:/.well-known/about.md -s write:/feed/photos.json
pups put about.md --to /.well-known/about.md --if-match '"etag-you-read"'
pups link add https://bigwide.net/ns/feed /feed/photos.json --type application/feed+json
pups put settings.json --to private/                           # the app's private folder: only it can read the file
```

Run `pups --help` for every command and option. Options can also come from `PUPS_CLIENT` and `PUPS_DOMAIN`.

**Credentials** are stored in `~/.config/pups/sessions.json` (or `$XDG_CONFIG_HOME/pups`, `$PUPS_CONFIG_DIR`), readable only by you. **Don't run two `pups` commands for the same domain at the same time**: if both renewed the token at once, the server would treat it as a stolen token and revoke the grant. Upload many files with one `pups put` instead.

## Browser library

```ts
import { PupsClient } from 'pups-client'

const pups = new PupsClient({
  clientId: 'https://app.example/oauth/client.json',   // your client metadata document
  redirectUri: 'https://app.example/callback',
})

// On every page load: completes a login redirect, or restores a stored session.
let session = await pups.init()

// Connect (in a click handler):
loginButton.onclick = () => pups.login(domainInput.value, { scopes: ['identify', 'appdata'] })
// …or without leaving the page:
loginButton.onclick = async () => session = await pups.loginWithPopup(domainInput.value)

console.log(`Signed in as ${session.me}`)

await session.put('notes/today.md', '# Hello')                     // unconditional
await session.create('posts/1.json', { title: 'First' })           // fails if it exists
await session.update('feed.json', async file => {                  // safe read-modify-write, retried on conflicts
  const feed = await file?.json<Feed>() ?? newFeed()
  feed.items.unshift(item)
  return feed
}, { contentType: 'application/feed+json' })
await session.delete('notes/today.md')

await session.hostMeta.addLink({ rel: 'https://app.example/rel/index', href: 'index.json' })
// A page of the site (scope write:/pups/pages/), hidden, with a title; then the order of all pages
await session.hostMeta.addLink({ rel: 'https://bigwide.net/ns/webpup-pages', href: '/pups/pages/imprint.md', type: 'text/markdown',
  titles: { default: 'Imprint' }, properties: { 'https://bigwide.net/ns/webpup-hidden': 'true' } })
await session.hostMeta.orderLinks('https://bigwide.net/ns/webpup-pages', [/* every page link's href, from hostMeta.get() */])
await session.logout()
```

Your app publishes its client metadata document on its own domain:

```json
{
  "client_id": "https://app.example/oauth/client.json",
  "client_name": "Example Reader",
  "client_uri": "https://app.example/",
  "redirect_uris": ["https://app.example/callback"]
}
```

During development, `await pups.checkClientMetadata()` reports everything a PUPS server would reject.

### Private files

Files in the app's private folder, `private/` in its own directory, can be read only by the app itself, with its token. The `appdata` scope covers them:

```ts
await session.put('private/settings.json', { theme: 'dark' })       // → /appdata/app.example/private/settings.json
const settings = await (await session.get('private/settings.json'))?.json()
```

Private files that extensions of RFC-6 define in `/pups/private/`, such as an inbox, are shared by every app the owner allows. Ask for `read:/pups/private/<path>` to read them, or `write:/pups/private/<path>` to read and write them; the server must declare the path in `server.wellKnownPaths`.

```ts
const session = await pups.loginWithPopup(domain, { scopes: ['appdata', 'read:/pups/private/inbox.json'] })
const inbox = await session.get('/pups/private/inbox.json')
```

Private files have no public URL: `publicUrl()` throws, `WriteResult.url` is absent, and they can't be linked in `host-meta.json`. `session.canRead(path)` and `session.isPrivate(path)` tell what the session may do. Private files are hidden from the public, not encrypted: whoever runs the server can read them.

### Feeds

`session.feed()` maintains a blog feed, or any similar stream of posts, on the owner's domain, following [RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md): the main feed `/feed.json`, or a named feed `/feed/<name>.json`, each a JSON Feed 1.1 with its archives, icons and media in a feed directory, `/feed/` or `/feed/<name>/`. Icons go into `/feed/images/icons/` (`/feed/<name>/images/icons/`), the main feed's media into `/feed/images/` and `/feed/media/`.

```ts
import { feedScopes } from 'pups-client'

const session = await pups.loginWithPopup(domain, { scopes: ['identify', ...feedScopes()] })   // or feedScopes('photos')
const feed = session.feed()                                       // or session.feed('photos')

const state = await feed.load()                                   // 'missing' | 'pups' | 'foreign' | 'invalid'
if (state.status == 'missing')
  await feed.create({ title: "Tim's Notes", description: 'Short notes', icon: iconFile })   // also registers it in host-meta.json
else if (state.status == 'foreign')
  showMessage('Your feed is maintained by other means.')          // never written without "_pups": { "pupsControlled": true }

const photo = await feed.uploadMedia(photoFile)                   // → https://…/feed/images/2026/….jpg
const post = await feed.addPost({ title: 'Hello', content_html: `<p>Hi!</p><img src="${photo.url}" alt="">` })
await feed.addPost({ markdown: 'Written in *Markdown*' })         // _source.markdown, with content_text as fallback
console.log(post.item.url)                                        // the post's page on the homepage, if the site declares one
await feed.editPost(post.id, { title: 'Hello, world' })           // wherever the post is now; the server sets date_modified
await feed.deletePost(post.id, { deleteMedia: true })             // also deletes media no other post uses
await feed.updateSettings({ description: 'Longer notes', _podcast: { explicit: false } })
if (feed.commentsAvailable && feed.comments(state.feed) == 'off')
  await feed.enableComments({ policy: { maxLength: 1000 } })       // comments go into the owner's inbox for approval

for await (const item of feed.posts()) console.log(item.id)       // newest first, through all archives
const feeds = await session.listFeeds()                           // the feeds registered in host-meta.json
```

- **Kept feeds** (RFC-7). The PUPS server keeps the feed: `addPost()`, `editPost()` and `deletePost()` each send one item with `POST` to the feed file, and the server gives new posts their index, puts them into the archives and writes the feed file. The library never writes archives. It needs a server with `"kept_feeds": true` in its configuration (`session.server.keptFeeds`); otherwise writes fail with `unsupported`. Settings (`updateSettings()`, icons, comments) are read-modify-writes of the feed file with ETags, repeated when another app or the owner wrote in between; the server keeps the items.
- **Archives** ([RFC-13](https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md)). Every post is in exactly one archive, `feed.000000.json`, `feed.000001.json`, … in the feed directory, 20 posts each, linked with `next_url`; posts never move. The feed file holds a copy of the newest 30 posts and points to the newest archive with `_archive.archive_url`. `feed.posts()` and `feed.getPost()` read them.
- **Post URLs.** `addPost()` returns `url`, the post's address: its archive URL plus `#<id>`. It never changes, so it can be the `source` of an RFC-4 webmention. If the site has a homepage that shows single posts, such as webpup, `host-meta.json` declares their URLs with the property `https://bigwide.net/ns/post-url-template` (`POST_URL_TEMPLATE`), and the server gives new posts the URL of their page as `url`, unless the app sets one. Show `post.item.url` as the post's link.
- **Comments on your feed.** If the server has a `comment_endpoint` (RFC-6 "Built-in receiver"), `feed.enableComments({ policy, tos })` opens the feed for RFC-4 comments: it writes `_submissions` into the feed file, with the endpoint as `url`, a `comments` policy (with `maxDepth: 5`: replies to comments up to five levels deep; `maxDepth: 1` allows comments on posts only) and `republish: "full"`. The server puts the comments into the owner's inbox; when the owner approves one, it publishes it in the post's comment feed, `/feed/comments/<index>.json`, and keeps the post's `_source.comments` (RFC-1) up to date: `{ count: 0, total: 0 }` while a post has no comments, and the comment feed's URL once it has some (RFC-7 "Publishing comments"). Replies to a comment go into that comment's own comment feed, `/feed/comments/<index>/<comment id>.json`, named by the comment's `_source.comments`; `total` counts all levels, and so does `commentLimit`. With `{ republish: 'summary' }`, the server publishes only an abstract, the first 150 characters of the plain text, linked to the comment; with `{ republish: 'no' }`, the owner only reads the comments. `feed.disableComments()` removes it, `feed.comments(doc)` tells whether comments go to this server (`pups`), another service (`other`) or nowhere (`off`). Archives don't copy `_submissions`: the feed file alone decides. Single posts are closed with `_commenting: { allowComments: false }`.
- **Indexes.** The server gives every post an index, `_archive.index` (also `PostResult.index`, or `itemIndex(item)`): 0 for the first post, then counting up, never changed and never given out again. Readers can number the posts and load only the archives they need. An edit sends the post with its index, which tells the server which post it is.
- Errors: `not_pups_controlled` for feeds without the marker, `invalid_feed` for files that aren't JSON Feeds, `not_found` for a missing feed or post.

### Mentions and submissions

A feed can tell the people a post names or answers ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)), and the owner can comment on other feeds ([RFC-4](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)):

```ts
const feed = session.feed(undefined, { mentions: true })
const post = await feed.addPost({ content_html: '<p>Great talk by <a href="https://alice.example/">@alice.example</a></p>' })
for (const r of await post.mentions ?? []) console.log(r.account, r.status)   // @alice.example accepted

const comment = await session.comments.post({ target: 'https://rm.example/groups/g/posts.json#a8Kd03', markdown: 'Agreed!' })
await session.mentions.submissionStatus(comment.submission!.statusUrl!)   // { status: 'success', pubUrl: … }

await session.mentions.notify(source, '@alice.example')           // the generic interface: any source, any account
await session.mentions.reply(source, 'https://bob.example/feed.json#p-12')
```

- **Asking first.** `feed.planMentions(input)` lists the accounts a post would notify, without sending anything, so the app can ask before posting. Each write takes `{ mentions }`: `true`, `false` (post without mentions), or the confirmed list:

  ```ts
  const planned = await feed.planMentions(input)               // [{ account: '@alice.example', kind: 'mention', target }]
  const confirmed = planned.length && await confirmDialog(planned) ? planned : false
  await feed.addPost(input, { mentions: confirmed })
  ```

  For an edit, plan with the new version and `{ previous: oldItem }`; for a delete, `planMentions(undefined, { previous: oldItem })`. `{ discover: true }` leaves out the domains without an endpoint, but looks them up before the post is published, which tells them that it names them.
- **Automatic mentions.** With `{ mentions: true }`, `addPost()`, `editPost()` and `deletePost()` find the handles in the post's title and visible text, e.g. `@alice.example`, also lists like `@alice.example/@bob.example`, but not e-mail addresses, fediverse addresses, names without a dot or paths. The author of the item a post answers (`_source.inReplyTo`) gets a reply mention. Each account is notified once, never the owner, at most 20 per post; after an edit or delete, everyone the old or the new version named.
- **After the upload.** The mentions are sent in the background, once the post is visible at its public URL (so that a CDN doesn't hand the receiver an old copy), with the archive URL plus `#<id>` as `source`. `post.mentions` resolves to one report per account (`accepted`, `rejected`, `failed`, `unknown` or `no-endpoint`) and never rejects; a failed mention never fails the post. Network errors, `5xx` and `429` are retried a few times; `feed.sendMentions(id)` sends again later.
- **Discovery.** The endpoint is the link `https://bigwide.net/ns/mention` in the domain's `host-meta.json`, cached for a day, failures for an hour. A domain without one, or whose `host-meta.json` doesn't allow CORS, gets nothing. An endpoint without CORS headers still receives the mention; its report says `unknown`.
- **Comments** on other feeds, and posts to discussion groups, are RFC-4 submissions. They never go into the owner's main feed: `session.comments` keeps them in comment feeds in the app's own directory, one file per target site and hour, `/appdata/<client-host>/comments/<hash3>/<hash>.json`, as RFC-7 "Comment feeds" recommends, which needs the `appdata` scope. `post()` adds the comment to its file (creating it if needed) and submits it to the target once it is visible; `edit(source, changes)` and `delete(source)` change the file and submit again with the same `source`; `{ submit: false }` writes without submitting. Show the target's terms of service and what `republish` means before the first submission. No mentions are sent for comments: the RFC-4 server sends them once it republishes the comment. `feed.submit()` is deprecated.
- `new Mentions({ fetch })` works without a session. `findHandles()`, `itemHandles()` and `visibleText()` are exported too.

### What the library does for you

- **Discovery** through `/.well-known/host-meta.json` and the configuration document.
- **OAuth 2.1** with PKCE (S256), the `state` and `iss` checks, and verification of the user's identity `me`.
- **Tokens**: refresh with rotation, prompt retries within the RFC's grace period when a response is lost, and a cross-tab lock so that two tabs never refresh at once.
- **Storage**: sessions in IndexedDB, encrypted with a non-extractable AES-GCM key. This protects stored data, not against script injected into your page (XSS); use a strict Content Security Policy.
- **RFC rules before sending**: paths, file types, scopes and size, with the same error codes the server uses.
- **ETags** for safe concurrent edits, and the **POST fallback** for servers behind firewalls that block `PUT`.
- **Fresh reads**: `get()` sends the token, so CDNs and caching proxies never hand back an old version, and the user sees their changes immediately. `get(path, { fresh: false })` reads without a token, except for private files, which always need it.

### Native apps and custom flows

`createAuthorization()` and `completeAuthorization()` run the same flow without touching `location` or `sessionStorage`. The CLI uses them with a loopback listener; see `src/cli/loopback.ts`.

### Errors

Everything throws `PupsError`, with a `code` you can switch on (`access_denied`, `session_expired`, `precondition_failed`, `insufficient_scope`, …), and `retryable` for network problems, `429` and `5xx`. `session_expired` means "connect again".

## Development

```sh
npm install
npm test            # unit and flow tests against an in-memory PUPS server
npm run typecheck
npm run build
```

The design is described in [CONCEPT.md](CONCEPT.md).

## License

MIT
