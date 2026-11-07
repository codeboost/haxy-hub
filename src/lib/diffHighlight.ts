import { useMemo } from "react"
import type { BundledLanguage } from "shiki/langs"
import type { DiffLine } from "@/lib/diff"
import { useHighlightedLines, type ThemedToken } from "@/lib/highlight"

/** One side of a hunk: its text, and where each hunk line falls in it (null when it isn't on that side). */
type Side = { lines: string[]; positions: (number | null)[] }

type LineTokens = ThemedToken[] | undefined

const onOldSide = (line: DiffLine) => line.kind !== "added"
const onNewSide = (line: DiffLine) => line.kind !== "removed"

function hunkSide(lines: readonly DiffLine[], onSide: (line: DiffLine) => boolean): Side {
  const text: string[] = []
  const positions = lines.map((line) => {
    if (!onSide(line)) return null
    text.push(line.text)
    return text.length - 1
  })
  return { lines: text, positions }
}

function sideTokens(side: Side, tokens: ThemedToken[][] | null, index: number): LineTokens {
  const position = side.positions[index]
  return position === null || tokens === null ? undefined : tokens[position]
}

function hunkTokens(lines: readonly DiffLine[], old: Side, oldTokens: ThemedToken[][] | null, current: Side, newTokens: ThemedToken[][] | null): LineTokens[] {
  return lines.map((line, index) => line.kind === "removed" ? sideTokens(old, oldTokens, index) : sideTokens(current, newTokens, index))
}

function isReady(side: Side, tokens: ThemedToken[][] | null): boolean {
  return side.lines.length === 0 || tokens !== null
}

/**
 * Each hunk line's tokens, or null until both sides are highlighted. The old
 * side (context and removed lines) and the new side (context and added lines)
 * are each highlighted as the code they were, so a construct one side opens
 * doesn't color the other's lines.
 */
export function useHighlightedHunk(lines: readonly DiffLine[], lang: BundledLanguage | null): LineTokens[] | null {
  const old = useMemo(() => hunkSide(lines, onOldSide), [lines])
  const current = useMemo(() => hunkSide(lines, onNewSide), [lines])
  const oldTokens = useHighlightedLines(old.lines, old.lines.length > 0 ? lang : null)
  const newTokens = useHighlightedLines(current.lines, current.lines.length > 0 ? lang : null)
  const ready = lang !== null && isReady(old, oldTokens) && isReady(current, newTokens)
  return useMemo(() => (ready ? hunkTokens(lines, old, oldTokens, current, newTokens) : null), [ready, lines, old, oldTokens, current, newTokens])
}
