import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router"
import { GitBranch, Search, Tag, Undo2 } from "lucide-react"
import { CloneButton } from "@/components/GitCommands"
import { RefPicker } from "@/components/RefPicker"
import type { Count } from "@/lib/api"
import { findRoute } from "@/lib/finder"
import { listRefs, refsRoute, repoRoute, type EncodedPath, type GitCommand, type ReadRef, type RefId, type RefKind, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

const countWindow = 100
const findShortcut = "t"

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

/** How many refs to show: Haxy's count when it gives one, else what one page holds, open-ended when there are more. */
function countLabel(count: Count, onPage: number, hasMore: boolean): string {
  if (count.kind === "exact") return String(count.value)
  if (count.kind === "at_least") return `${count.value}+`
  return hasMore ? `${onPage}+` : String(onPage)
}

function useRefCount(repo: RepoLocator, kind: RefKind): string | null {
  const page = useResource(`ref count ${repoKey(repo)} ${kind}`, (signal) => listRefs(repo, kind, { page_size: countWindow }, { signal }))
  if (page.kind !== "loaded") return null
  return countLabel(page.data.page.count, page.data.items.length, page.data.page.has_more)
}

function RefCount({ repo, kind }: { repo: RepoLocator; kind: RefKind }) {
  const count = useRefCount(repo, kind)
  const Icon = kind === "branch" ? GitBranch : Tag
  const noun = kind === "branch" ? (count === "1" ? "Branch" : "Branches") : count === "1" ? "Tag" : "Tags"
  return (
    <Link to={refsRoute(repo, kind)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <Icon size={15} aria-hidden />
      {count !== null && <strong className="font-semibold text-foreground">{count}</strong>}
      {noun}
    </Link>
  )
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
}

/** A box that opens the file finder at this ref with what was typed; `t` opens it from anywhere on the page. */
function GoToFile({ repo, refId }: { repo: RepoLocator; refId: RefId | null }) {
  const navigate = useNavigate()
  const [text, setText] = useState("")

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== findShortcut || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      event.preventDefault()
      navigate(findRoute(repo, refId))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate, repo, refId])

  return (
    <form role="search" aria-label="Go to file" onSubmit={(event) => { event.preventDefault(); navigate(findRoute(repo, refId, text ? { search: text } : {})) }} className="flex h-8 w-full items-center gap-2 rounded-md border bg-card px-2.5 text-sm focus-within:ring-2 focus-within:ring-ring sm:w-60">
      <Search size={15} aria-hidden className="shrink-0 text-muted-foreground" />
      <input value={text} onChange={(event) => setText(event.target.value)} aria-label="Go to file" placeholder="Go to file" className="min-w-0 flex-1 bg-transparent outline-none" />
      <kbd aria-hidden className="rounded border px-1.5 font-mono text-xs text-muted-foreground">{findShortcut}</kbd>
    </form>
  )
}

/**
 * The files view's toolbar: the ref (a picker, and away from the default
 * branch the way back to it), the branch and tag counts, Go to file and
 * the clone commands behind Code.
 */
export function RepoToolbar({ repo, path, refId, read, clone }: { repo: RepoLocator; path: EncodedPath; refId: RefId | null; read: ReadRef; clone: GitCommand[] }) {
  return (
    <section aria-label="Ref" className="flex flex-wrap items-center gap-2">
      <RefPicker repo={repo} path={path} read={read} />
      {refId !== null && (
        <Link to={repoRoute(repo, path)} className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Undo2 size={14} aria-hidden />Default branch
        </Link>
      )}
      <RefCount repo={repo} kind="branch" />
      <RefCount repo={repo} kind="tag" />
      <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
        <GoToFile repo={repo} refId={refId} />
        {clone.length > 0 && <CloneButton commands={clone} />}
      </div>
    </section>
  )
}
