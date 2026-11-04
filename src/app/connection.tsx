import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { checkBackend, type BackendCheck } from "@/lib/connection"

export type ConnectionState = {
  /** The latest completed check; null until the first one finishes. */
  check: BackendCheck | null
  /** True while a check is in flight (the previous result stays visible). */
  checking: boolean
  retry(): void
}

const ConnectionContext = createContext<ConnectionState | null>(null)

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  const [check, setCheck] = useState<BackendCheck | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    setChecking(true)
    checkBackend(controller.signal).then(
      (result) => {
        setCheck(result)
        setChecking(false)
      },
      () => {
        // Only an abort rejects; a newer check has replaced this one.
      },
    )
    return () => controller.abort()
  }, [attempt])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  return <ConnectionContext value={{ check, checking, retry }}>{children}</ConnectionContext>
}

export function useConnection(): ConnectionState {
  const value = useContext(ConnectionContext)
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider")
  return value
}
