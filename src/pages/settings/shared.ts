import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { ApiError } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"

export const linkClass = "text-primary underline-offset-4 hover:underline"

/** The settings pages, by the route segment after `settings`. */
export type AdminPage = "" | "members" | "branches" | "delete"

/** The Hub route of a repository's settings page: `/repos/<owner>/<name>/settings[/<page>]` (`/repo/settings` in local mode, which has none). */
export function adminRoute(repo: RepoLocator, page: AdminPage = ""): string {
  const base = repo.kind === "local" ? "/repo" : `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  return `${base}/settings${page ? `/${page}` : ""}`
}

/**
 * Orders a form's async work: `begin()` starts an operation (a write, or a
 * read that settles one) and `isLatest(started)` says whether it may still
 * change the page: false once the form is gone, or once a newer operation
 * began, whose answer is the one that counts.
 */
export function useLatest(): { begin(): number; isLatest(started: number): boolean } {
  const mounted = useRef(true)
  const generation = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return {
    begin: () => ++generation.current,
    isLatest: (started) => mounted.current && started === generation.current,
  }
}

/**
 * One form's (or row's) writes, so every one follows the same rules:
 *
 * - `busy` while a write or a check runs. Nothing else starts meanwhile, and
 *   it clears however the operation ends (answer, refusal, unknown outcome,
 *   thrown error), unless the form is gone. Forms disable their fields while
 *   `blocked`, so no edit is made that a completion could overwrite.
 * - `unresolved`: a write whose outcome is unknown and that a read couldn't
 *   settle. It may still land, so `start` refuses another write until a
 *   `check` settles it and clears it (`setUnresolved(null)`).
 * - Each operation gets `current()`: false once the form is gone. Every state
 *   change after an await checks it.
 */
export type Write<U> = {
  busy: boolean
  unresolved: U | null
  /** busy, or unresolved: no new write may start, and edits wait */
  blocked: boolean
  setUnresolved(value: U | null): void
  /** Runs a write, unless one is running or unresolved. */
  start(operation: (current: () => boolean) => Promise<void>): Promise<void>
  /** Runs a check of the unresolved write, unless something is running or nothing is unresolved. */
  check(operation: (unresolved: U, current: () => boolean) => Promise<void>): Promise<void>
}

export function useWrite<U>(): Write<U> {
  const latest = useLatest()
  // refs as well as state: a second click can arrive before a render
  const busyRef = useRef(false)
  const unresolvedRef = useRef<U | null>(null)
  const [busy, setBusy] = useState(false)
  const [unresolved, setUnresolvedState] = useState<U | null>(null)

  function setUnresolved(value: U | null) {
    unresolvedRef.current = value
    setUnresolvedState(value)
  }

  async function run(operation: (current: () => boolean) => Promise<void>) {
    const started = latest.begin()
    const current = () => latest.isLatest(started)
    busyRef.current = true
    setBusy(true)
    try {
      await operation(current)
    } finally {
      if (current()) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  return {
    busy,
    unresolved,
    blocked: busy || unresolved !== null,
    setUnresolved,
    start: (operation) => (busyRef.current || unresolvedRef.current !== null ? Promise.resolve() : run(operation)),
    check(operation) {
      const pending = unresolvedRef.current
      return busyRef.current || pending === null ? Promise.resolve() : run((current) => operation(pending, current))
    },
  }
}

/**
 * Whether a read that settles a write failed because the viewer can no longer
 * manage or see the repository (no longer an owner, signed out, or the
 * repository is gone or hidden). That is an answer, not an outage: checking
 * again can't do better.
 */
export function lostAccess(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "forbidden" || error.code === "not_found" || error.code === "unauthenticated")
}

/**
 * Hands over to the settings' own answer once the viewer has lost access:
 * reads the repository and its settings again, which then say that the
 * viewer no longer manages it (or that it's gone) and drop the Settings tab.
 */
export function useLeaveSettings(): () => void {
  const navigate = useNavigate()
  const location = useLocation()
  return () => void navigate(location.pathname + location.search, { replace: true })
}
