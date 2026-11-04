import { useCallback, useEffect, useState } from "react"
import { ApiError } from "@/lib/api"

/** One read from the API, as a page presents it. */
export type Resource<T> =
  | { kind: "loading" }
  | { kind: "loaded"; data: T }
  | { kind: "failed"; error: ApiError }

/**
 * Loads `load` whenever `key` changes (or `reload` is called), aborting the
 * previous request. Pages render loading, loaded and failed states distinctly,
 * so an empty result is never confused with a failure.
 */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Resource<T> & { reload(): void } {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; attempt: number; resource: Resource<T> }>({ key, attempt, resource: { kind: "loading" } })

  useEffect(() => {
    const controller = new AbortController()
    setState({ key, attempt, resource: { kind: "loading" } })
    load(controller.signal).then(
      (data) => setState({ key, attempt, resource: { kind: "loaded", data } }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        const apiError = error instanceof ApiError ? error : new ApiError("invalid_response", "Haxy Hub could not read Haxy's answer.", 0)
        setState({ key, attempt, resource: { kind: "failed", error: apiError } })
      },
    )
    return () => controller.abort()
    // `load` is keyed by `key`; a new closure for the same key must not refetch.
  }, [key, attempt])

  const reload = useCallback(() => setAttempt((value) => value + 1), [])
  // Until the effect runs for a new key, the old result belongs to another view.
  const current = state.key === key && state.attempt === attempt ? state.resource : { kind: "loading" as const }
  return { ...current, reload }
}
