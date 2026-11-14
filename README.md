# pups-client

The reference client for **Personal Upload Servers** (PUPS, [bigwide.net RFC-6](../RFCs/RFC-6-Personal-Upload-Server.md)): sign a user in with their own domain, and write files to it.

- **Browser library** in TypeScript, without runtime dependencies.
- **Command line tool** `pups`, for uploading from a terminal or a script.

PUPS lets any app write files to a user's domain, knowing nothing but the domain. The user approves the app at their own server with standard OAuth, and everything the app writes is published as static files.

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
pups put feed.json --to feeds/                 # → /appdata/tim.example.app/feeds/feed.json
echo '# Hi' | pups put - --to hello.md         # from stdin
pups get hello.md
pups rm hello.md
pups logout                                    # forgets the credentials and revokes the grant
```

Paths without a leading `/` are in the app's own directory, `/appdata/<client-domain>/`. To write elsewhere, ask for a well-known path the server declares:

```sh
pups login tjansen.de -c tim.example.app -s appdata -s write:/.well-known/about.md
pups put about.md --to /.well-known/about.md --if-match '"etag-you-read"'
pups link add https://bigwide.net/ns/feed /feeds/bigwide/feed.xml --type application/rss+xml
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

### What the library does for you

- **Discovery** through `/.well-known/host-meta.json` and the configuration document.
- **OAuth 2.1** with PKCE (S256), the `state` and `iss` checks, and verification of the user's identity `me`.
- **Tokens**: refresh with rotation, prompt retries within the RFC's grace period when a response is lost, and a cross-tab lock so that two tabs never refresh at once.
- **Storage**: sessions in IndexedDB, encrypted with a non-extractable AES-GCM key. This protects stored data, not against script injected into your page (XSS); use a strict Content Security Policy.
- **RFC rules before sending**: paths, file types, scopes and size, with the same error codes the server uses.
- **ETags** for safe concurrent edits, and the **POST fallback** for servers behind firewalls that block `PUT`.

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
