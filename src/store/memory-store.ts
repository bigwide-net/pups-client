import type { SessionRecord, TokenStore } from './token-store.js'

/**
 * Keeps sessions in memory only: nothing survives a reload, and other tabs don't see them.
 * For high-risk apps and for tests.
 */
export class MemoryTokenStore implements TokenStore {
  readonly #records = new Map<string, SessionRecord>()

  async get(clientId: string, me: string) {
    const record = this.#records.get(key(clientId, me))
    return record && structuredClone(record)
  }

  async list(clientId: string) {
    return [...this.#records.values()].filter(r => r.clientId == clientId).map(r => structuredClone(r))
  }

  async put(record: SessionRecord) {
    this.#records.set(key(record.clientId, record.me), structuredClone(record))
  }

  async delete(clientId: string, me: string) {
    this.#records.delete(key(clientId, me))
  }
}

const key = (clientId: string, me: string) => `${clientId}\n${me}`
