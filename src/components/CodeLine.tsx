import type { CSSProperties } from "react"
import type { ThemedToken } from "@/lib/highlight"

const italic = 1
const bold = 2
const underline = 4

function tokenStyle(token: ThemedToken): CSSProperties {
  const style = token.fontStyle ?? 0
  return {
    color: token.color,
    fontStyle: style & italic ? "italic" : undefined,
    fontWeight: style & bold ? "bold" : undefined,
    textDecoration: style & underline ? "underline" : undefined,
  }
}

/** One line of code: its highlighted tokens when there are any, else its text. */
export function CodeLine({ text, tokens }: { text: string; tokens: ThemedToken[] | undefined }) {
  if (tokens === undefined) return text
  return tokens.map((token, index) => <span key={index} style={tokenStyle(token)}>{token.content}</span>)
}
