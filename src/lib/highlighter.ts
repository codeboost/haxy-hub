import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, type BundledLanguage } from "shiki/langs"

const themeName = "haxy"
const maxTokenizedLineLength = 1_000

const theme = createCssVariablesTheme({ name: themeName, variablePrefix: "--syntax-" })

let highlighter: Promise<HighlighterCore> | null = null

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
  return highlighter
}

async function loadLanguage(shiki: HighlighterCore, lang: BundledLanguage): Promise<void> {
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(bundledLanguages[lang])
}

/** One list of tokens per line, or null when the lines can't be highlighted. */
export async function highlightLines(lines: readonly string[], lang: BundledLanguage): Promise<ThemedToken[][] | null> {
  const shiki = await loadHighlighter()
  await loadLanguage(shiki, lang)
  const tokens = shiki.codeToTokensBase(lines.join("\n"), { lang, theme: themeName, tokenizeMaxLineLength: maxTokenizedLineLength })
  return tokens.length === lines.length ? tokens : null
}
