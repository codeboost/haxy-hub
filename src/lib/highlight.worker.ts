import type { BundledLanguage } from "shiki/langs"
import { highlightLines } from "@/lib/highlighter"

export type HighlightRequest = { id: number; lines: readonly string[]; lang: BundledLanguage }

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  const { id, lines, lang } = event.data
  highlightLines(lines, lang).then(
    (tokens) => self.postMessage({ id, tokens }),
    () => self.postMessage({ id, tokens: null }),
  )
})
