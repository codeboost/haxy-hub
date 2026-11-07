import { startTransition, use, useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { useLocation } from "react-router"
import { ApiError } from "@/lib/api"

/** One read from the API, as a page presents it. */
export type Resource<T> =
  | { kind: "loaded"; data: T }
  | { kind: "failed"; error: ApiError }

type Load<T> = (signal: AbortSignal) => Promise<T>

type Entry = {
  promise: Promise<Resource<unknown>>
  result: Resource<unknown> | null
  locationKey: string
  settledAt: number | null
}

type Held = { entryKey: string; revalidate: string; promise: Promise<Resource<unknown>> }

const abandonedAfterMs = 60_000

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let pendingCount = 0

function notify() {
  for (const listener of listeners) listener()
}

function markFulfilled(promise: Promise<Resource<unknown>>, result: Resource<unknown>) {
  // the fields React's `use` reads, so a settled read renders without suspending
  Object.assign(promise, { status: "fulfilled", value: result })
}

function fulfilled(result: Resource<unknown>): Promise<Resource<unknown>> {
  const promise = Promise.resolve(result)
  markFulfilled(promise, result)
  return promise
}

function settle<T>(load: Load<T>, signal: AbortSignal): Promise<Resource<T>> {
  return load(signal).then(
    (data): Resource<T> => ({ kind: "loaded", data }),
    (error: unknown): Resource<T> => ({ kind: "failed", error: error instanceof ApiError ? error : new ApiError("invalid_response", "Haxy Hub could not read Haxy's answer.", 0) }),
  )
}

function isAbandoned(entry: Entry, now: number): boolean {
  return entry.settledAt !== null && now - entry.settledAt > abandonedAfterMs
}

function sweep(now: number) {
  for (const [key, entry] of entries) if (isAbandoned(entry, now)) entries.delete(key)
}

function isReusable(entry: Entry | undefined, locationKey: string): entry is Entry {
  if (entry === undefined) return false
  return entry.result === null || (entry.locationKey === locationKey && !isAbandoned(entry, Date.now()))
}

function start<T>(entryKey: string, locationKey: string, load: Load<T>): Entry {
  sweep(Date.now())
  const promise = settle(load, new AbortController().signal) as Promise<Resource<unknown>>
  const entry: Entry = { promise, result: null, locationKey, settledAt: null }
  entries.set(entryKey, entry)
  pendingCount += 1
  queueMicrotask(notify)
  void promise.then((result) => {
    markFulfilled(promise, result)
    entry.result = result
    entry.settledAt = Date.now()
    pendingCount -= 1
    notify()
  })
  return entry
}

function entryFor<T>(entryKey: string, locationKey: string, load: Load<T>): Entry {
  const existing = entries.get(entryKey)
  return isReusable(existing, locationKey) ? existing : start(entryKey, locationKey, load)
}

function release(entryKey: string) {
  const entry = entries.get(entryKey)
  if (entry?.result) entries.delete(entryKey)
}

function refreshInBackground<T>(load: Load<T>, apply: (result: Resource<T>) => void): () => void {
  const controller = new AbortController()
  void settle(load, controller.signal).then((result) => {
    if (!controller.signal.aborted) apply(result)
  })
  return () => controller.abort()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a page is waiting on a read before it can show. */
export function useReadsPending(): boolean {
  return useSyncExternalStore(subscribe, () => pendingCount > 0)
}

/**
 * Reads `load` for `key`, suspending until it settles: inside a navigation
 * the page shown stays until the next one has its data. Each new mount, key
 * and `reload` reads afresh. A change of `revalidate` (such as the location
 * within a page) reads again in the background, keeping what was loaded
 * shown until the fresh answer replaces it.
 */
export function useResource<T>(key: string, load: Load<T>, revalidate = ""): Resource<T> & { reload(): void } {
  const { key: locationKey } = useLocation()
  const [attempt, setAttempt] = useState(0)
  const [held, setHeld] = useState<Held | null>(null)
  const entryKey = `${attempt} ${key}`
  const promise = held?.entryKey === entryKey ? held.promise : entryFor(entryKey, locationKey, load).promise
  const result = use(promise) as Resource<T>

  useEffect(() => {
    if (held?.entryKey !== entryKey) {
      release(entryKey)
      setHeld({ entryKey, revalidate, promise })
      return
    }
    if (held.revalidate === revalidate) return
    // `load` is keyed by `key`; a new closure for the same key must not refetch.
    return refreshInBackground(load, (fresh) => setHeld({ entryKey, revalidate, promise: fulfilled(fresh) }))
  }, [entryKey, revalidate, held])

  const reload = useCallback(() => startTransition(() => setAttempt((value) => value + 1)), [])
  return { ...result, reload }
}
