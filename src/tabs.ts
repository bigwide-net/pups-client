import type { CallbackParams } from './oauth.js'

/** Messages between tabs of the same app. They never carry tokens; tabs reread the store instead. */
export type TabMessage =
  | { type: 'login' | 'logout' | 'tokens'; me: string }
  | { type: 'expired'; me: string; message: string }
  /** From the popup's redirect page to the tab that opened it. */
  | { type: 'callback'; params: CallbackParams }

const localLocks = new Map<string, Promise<unknown>>()

/**
 * Runs `fn` while holding the lock `name`, exclusively across all tabs and workers of the origin (Web Locks API).
 * The browser releases the lock if the tab closes. Without Web Locks, the lock only covers this tab.
 */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator == 'undefined' ? undefined : navigator.locks
  if (locks) return locks.request(name, fn) as Promise<T>
  const previous = localLocks.get(name) ?? Promise.resolve()
  const result = previous.then(fn, fn)
  const tail = result.catch(() => {})
  localLocks.set(name, tail)
  tail.then(() => localLocks.get(name) == tail && localLocks.delete(name))
  return result
}

/** A `BroadcastChannel` for one app, or a no-op where the browser has none. */
export class TabChannel {
  readonly #channel?: BroadcastChannel
  readonly #listeners = new Set<(message: TabMessage) => void>()
  #closed = false

  constructor(name: string) {
    if (typeof BroadcastChannel == 'undefined') return
    this.#channel = new BroadcastChannel(name)
    // In Node (CLI, tests) an open channel would keep the process alive.
    ;(this.#channel as { unref?: () => void }).unref?.()
    this.#channel.onmessage = (event: MessageEvent<TabMessage>) => {
      for (const listener of this.#listeners) listener(event.data)
    }
  }

  post(message: TabMessage) {
    if (this.#closed) return
    try {
      this.#channel?.postMessage(message)
    } catch {
      // Telling other tabs is best-effort; it must never fail the operation that changed the session.
    }
  }

  subscribe(listener: (message: TabMessage) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  close() {
    this.#closed = true
    this.#channel?.close()
  }
}
