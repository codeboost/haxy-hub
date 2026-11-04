import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router"
import { useConnection } from "@/app/connection"
import { ApiError } from "@/lib/api"
import { fetchSession, logIn as postLogin, logOut as deleteSession, type Session, type Viewer } from "@/lib/session"

export type SessionState = {
  /** False until the viewer is known, and again after a page is restored from the back/forward cache. */
  ready: boolean
  /** Who is logged in; null when nobody is, and always in local mode. */
  viewer: Viewer | null
  /**
   * Changes whenever the viewer does. Viewer-specific client state lives under
   * a tree keyed by this (see AppShell), so logging out or switching accounts
   * discards all of it.
   */
  viewerKey: string
  /** Logs in; rejects with an ApiError (`unauthenticated`, `validation`, …) and leaves the viewer as it was. */
  logIn(username: string, password: string): Promise<void>
  /** Logs out; rejects with an ApiError and leaves the viewer as it was if the backend didn't confirm. */
  logOut(): Promise<void>
  /**
   * Runs another request that changes who is logged in (registration, account
   * deletion) and answers with the new session, which then wins as a login does.
   */
  changeSession(run: () => Promise<Session>): Promise<void>
}

const SessionContext = createContext<SessionState | null>(null)

type Known = { ready: boolean; viewer: Viewer | null }

/**
 * Reads the viewer from Haxy and keeps it current: on every navigation (so a
 * session revoked elsewhere shows as logged out on the next request), and
 * when the browser restores a page from its back/forward cache.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { check } = useConnection()
  const connected = check?.kind === "connected"
  const location = useLocation()
  const [known, setKnown] = useState<Known>({ ready: false, viewer: null })
  // Bumped to read the session again: after a bfcache restore, or after a
  // login or logout failed without saying what the backend did.
  const [reread, setReread] = useState(0)
  // A confirmed login or logout always wins over reads: a read that overlaps
  // one (started before it ended, or while it is pending) may describe the
  // state before it, so its answer is dropped. `epoch` changes when a login or
  // logout starts and ends.
  const epoch = useRef(0)
  const pendingChanges = useRef(0)
  const read = useRef<AbortController | null>(null)

  const show = useCallback((viewer: Viewer | null) => {
    setKnown((previous) => (previous.ready && previous.viewer?.name === viewer?.name ? previous : { ready: true, viewer }))
  }, [])

  useEffect(() => {
    if (!connected) return
    const started = epoch.current
    const controller = new AbortController()
    read.current = controller
    const current = () => !controller.signal.aborted && started === epoch.current && pendingChanges.current === 0
    fetchSession(controller.signal).then(
      (session) => { if (current()) show(session.viewer) },
      (error: unknown) => {
        // A backend that can't report a session is treated as having no viewer.
        if (current() && error instanceof ApiError) show(null)
      },
    )
    return () => controller.abort()
  }, [connected, location.key, reread, show])

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      // The restored page may show a viewer who has since logged out: hide
      // viewer-specific content until the session is read again.
      epoch.current++
      setKnown({ ready: false, viewer: null })
      setReread((value) => value + 1)
    }
    window.addEventListener("pageshow", onPageShow)
    return () => window.removeEventListener("pageshow", onPageShow)
  }, [])

  const change = useCallback(async (run: () => Promise<Session>) => {
    epoch.current++
    pendingChanges.current++
    read.current?.abort()
    try {
      const session = await run()
      show(session.viewer)
    } catch (error) {
      // Not confirmed: keep what is shown, and read the authoritative state.
      setReread((value) => value + 1)
      throw error
    } finally {
      pendingChanges.current--
      epoch.current++
    }
  }, [show])

  const logIn = useCallback((username: string, password: string) => change(() => postLogin(username, password)), [change])
  const logOut = useCallback(() => change(deleteSession), [change])

  const viewerKey = known.viewer ? `user:${known.viewer.name}` : "anonymous"
  return <SessionContext value={{ ...known, viewerKey, logIn, logOut, changeSession: change }}>{children}</SessionContext>
}

export function useSession(): SessionState {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession must be used inside SessionProvider")
  return value
}
