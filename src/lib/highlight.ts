import { useEffect, useState } from "react"
import type { ThemedToken } from "shiki/core"
import type { BundledLanguage } from "shiki/langs"
import type { HighlightRequest } from "@/lib/highlight.worker"

export type { ThemedToken }

const maxHighlightedChars = 500_000

function isWithinLimit(lines: readonly string[]): boolean {
  return lines.reduce((total, line) => total + line.length, 0) <= maxHighlightedChars
}

type Tokens = ThemedToken[][] | null
type HighlightResponse = { id: number; tokens: Tokens }

const pending = new Map<number, (tokens: Tokens) => void>()
let nextId = 0
let worker: Worker | "failed" | null = null

function fail() {
  worker = "failed"
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
}

function settle({ id, tokens }: HighlightResponse) {
  pending.get(id)?.(tokens)
  pending.delete(id)
}

function startWorker(): Worker {
  const started = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" })
  started.addEventListener("message", (event: MessageEvent<HighlightResponse>) => settle(event.data))
  started.addEventListener("error", fail)
  started.addEventListener("messageerror", fail)
  return started
}

function highlightLines(lines: readonly string[], lang: BundledLanguage): Promise<Tokens> {
  worker ??= startWorker()
  if (worker === "failed") return Promise.resolve(null)
  const running = worker
  const id = nextId++
  const request: HighlightRequest = { id, lines, lang }
  return new Promise((resolve) => {
    pending.set(id, resolve)
    running.postMessage(request)
  })
}

type Highlighted = { lines: readonly string[]; lang: BundledLanguage; tokens: ThemedToken[][] }

/**
 * `lines` highlighted as `lang`, or null while the grammar loads, for plain
 * text, past the size limit, or when highlighting fails.
 */
export function useHighlightedLines(lines: readonly string[], lang: BundledLanguage | null): ThemedToken[][] | null {
  const [result, setResult] = useState<Highlighted | null>(null)
  useEffect(() => {
    if (lang === null || !isWithinLimit(lines)) return
    let current = true
    highlightLines(lines, lang).then(
      (tokens) => { if (current && tokens) setResult({ lines, lang, tokens }) },
      () => {},
    )
    return () => { current = false }
  }, [lines, lang])
  return result !== null && result.lines === lines && result.lang === lang ? result.tokens : null
}
