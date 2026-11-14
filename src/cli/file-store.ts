import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionRecord, TokenStore } from '../store/token-store.js'

interface StoreFile {
  version: 1
  sessions: SessionRecord[]
}

/**
 * Keeps sessions in a JSON file that only the current user can read (mode 0600, directory 0700), the way
 * command line tools like `gh` or `gcloud` keep their credentials.
 *
 * Writes go to a temporary file that is renamed over the old one, so a crash never leaves a half-written file.
 * The file is not locked against other processes: don't run two `pups` commands for the same domain at the same
 * time, or both may refresh with the same refresh token, which makes the server revoke the grant.
 */
export class FileTokenStore implements TokenStore {
  constructor(readonly file: string) {}

  async get(clientId: string, me: string) {
    return (await this.#read()).find(r => r.clientId == clientId && r.me == me)
  }

  async list(clientId: string) {
    return (await this.#read()).filter(r => r.clientId == clientId)
  }

  /** All sessions, of every client. */
  listAll() {
    return this.#read()
  }

  async put(record: SessionRecord) {
    const records = (await this.#read()).filter(r => r.clientId != record.clientId || r.me != record.me)
    await this.#write([...records, record])
  }

  async delete(clientId: string, me: string) {
    const records = await this.#read()
    const remaining = records.filter(r => r.clientId != clientId || r.me != me)
    if (remaining.length != records.length) await this.#write(remaining)
  }

  async #read(): Promise<SessionRecord[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code == 'ENOENT') return []
      throw e
    }
    const data = JSON.parse(text) as StoreFile
    return Array.isArray(data.sessions) ? data.sessions : []
  }

  async #write(sessions: SessionRecord[]) {
    const dir = dirname(this.file)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    const data: StoreFile = { version: 1, sessions }
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, this.file)
  }
}
