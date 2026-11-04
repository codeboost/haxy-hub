import { createContext, useContext, type ReactNode } from "react"
import { Link } from "react-router"
import { linkTarget, type LinkTarget, type MarkdownBlock, type MarkdownInline } from "@/lib/markdown"

// Where this document's links lead; a repository file resolves its own paths.
const LinkResolver = createContext<(destination: string) => LinkTarget>(linkTarget)

function InlineRun({ run }: { run: MarkdownInline }) {
  // Hard breaks arrive as newlines inside the text.
  let node: ReactNode = run.text.split("\n").flatMap((part, index) => (index === 0 ? [part] : [<br key={index} />, part]))
  if (run.code) node = <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.9em]">{node}</code>
  if (run.bold) node = <strong>{node}</strong>
  if (run.italic) node = <em>{node}</em>
  if (run.strike) node = <s>{node}</s>
  const resolve = useContext(LinkResolver)
  if (run.link === null) return node
  const target = resolve(run.link)
  const linkClass = "text-primary underline underline-offset-4"
  switch (target.kind) {
    case "external": return <a href={target.href} className={linkClass} rel="noreferrer noopener">{node}</a>
    case "internal": return <Link to={target.to} className={linkClass}>{node}</Link>
    case "none": return node
  }
}

function Inlines({ inlines }: { inlines: MarkdownInline[] }) {
  return inlines.map((run, index) => <InlineRun key={index} run={run} />)
}

const headingClass = ["", "text-2xl font-semibold", "text-xl font-semibold", "text-lg font-semibold", "font-semibold", "font-semibold", "font-semibold"]

function Block({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case "heading": {
      // The page owns the h1; document headings start one level below.
      const level = Math.min(Math.max(block.level, 1) + 1, 6)
      const Tag = `h${level}` as "h2"
      return <Tag className={`${headingClass[block.level] ?? "font-semibold"} ${block.center ? "text-center" : ""}`}><Inlines inlines={block.inlines} /></Tag>
    }
    case "paragraph":
      return <p className={`${block.center ? "text-center" : ""} ${block.pre ? "whitespace-pre-wrap" : ""}`}><Inlines inlines={block.inlines} /></p>
    case "code":
    case "raw":
      return <pre className="overflow-x-auto rounded-lg bg-secondary p-4 font-mono text-sm">{block.lines.join("\n")}</pre>
    case "quote":
      return <blockquote className="border-l-4 pl-4 text-muted-foreground"><Blocks blocks={block.blocks} /></blockquote>
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          {item.task !== null && <input type="checkbox" checked={item.task} disabled aria-label={item.task ? "Done" : "Not done"} className="mr-2 align-middle" />}
          <Blocks blocks={item.blocks} />
        </li>
      ))
      return block.ordered
        ? <ol start={block.start} className="list-decimal space-y-1 pl-6">{items}</ol>
        : <ul className="list-disc space-y-1 pl-6">{items}</ul>
    }
    case "rule":
      return <hr />
  }
}

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return <div className="space-y-4">{blocks.map((block, index) => <Block key={index} block={block} />)}</div>
}

/**
 * Markdown parsed by Haxy. Text is rendered as text; only safe link targets
 * become links. `resolveLink` decides where links lead (by default, as on the
 * about page); it must only ever return safe targets.
 */
export function Markdown({ blocks, resolveLink = linkTarget }: { blocks: MarkdownBlock[]; resolveLink?: (destination: string) => LinkTarget }) {
  return <LinkResolver value={resolveLink}><div className="leading-relaxed"><Blocks blocks={blocks} /></div></LinkResolver>
}
