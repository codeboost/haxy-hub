import { useEffect, useMemo, useRef } from "react"
import { useLocation } from "react-router"

function historyKey(): string {
  const state = window.history.state as { key?: unknown } | null
  return typeof state?.key === "string" && state.key ? state.key : "default"
}

/**
 * Whether the calling page is still the one the user is on: mounted, and the
 * browser still at its history entry. A navigation away moves the browser at
 * once, while the page stays shown until the next one has read what it shows,
 * so a write finishing meanwhile must not pull the user back.
 */
export function useStillHere(): { readonly current: boolean } {
  const { key } = useLocation()
  const mounted = useRef(false)
  const shownKey = useRef(key)
  useEffect(() => {
    mounted.current = true
    shownKey.current = key
    return () => { mounted.current = false }
  }, [key])
  return useMemo(() => ({ get current() { return mounted.current && historyKey() === shownKey.current } }), [])
}
