import { useEffect, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureState, LoadingState } from "@/components/listing"
import type { ApiError } from "@/lib/api"
import { useSession } from "@/app/session"
import type { RepoLocator } from "@/lib/repo"
import { useResource, type Resource } from "@/lib/resource"
import { loginPath } from "@/lib/session"
import { nextReadOrder } from "@/lib/notifications"
import { commentAnchor, listComments, threadCommentsRoute, type CommentPermalink, type CommentWindow, type ThreadComment } from "@/lib/comments"
import { linkClass, type ThreadConfig } from "./config"
import { CommentCard } from "./CommentCard"
import { CommentComposer } from "./CommentForms"

/**
 * The comment a URL's fragment points at (`#comment-<id>`), brought into view
 * and focused once the window holding it has loaded, so a link to a comment
 * on a later page (which carries that page in its query) opens at it, after
 * a refresh too. Returns the focused id.
 */
export function useFocusedComment(loaded: unknown): string | null {
  const { hash, key } = useLocation()
  const prefix = `#${commentAnchor("")}`
  // a comment id is 32 lowercase hex digits; any other fragment points at nothing
  const candidate = hash.startsWith(prefix) ? hash.slice(prefix.length) : ""
  const focused = /^[0-9a-f]{32}$/.test(candidate) ? candidate : null
  // once per navigation: a later read of the same window (after a write) leaves focus where the user put it
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (!loaded || !focused || done.current === key) return
    const element = document.getElementById(commentAnchor(focused))
    if (!element) return
    done.current = key
    element.scrollIntoView({ block: "center" })
    element.focus({ preventScroll: true })
  }, [loaded, focused, key])
  return focused
}

/**
 * A comment page's read as the page shows it: only the first load (for a
 * key) may replace the page with a failure. Once something has loaded, a
 * later read that fails, or that is being retried, keeps showing it, so the
 * cards and every open draft stay mounted; the failure comes separately, in
 * `refreshFailed`.
 */
export type Kept<T> = { kind: "loading" } | { kind: "failed"; error: ApiError } | { kind: "loaded"; data: T; refreshFailed: ApiError | null }

export function useKept<T>(resource: Resource<T>, key: string): Kept<T> {
  const kept = useRef<{ key: string; data: T } | null>(null)
  if (resource.kind === "loaded") kept.current = { key, data: resource.data }
  const last = kept.current?.key === key ? kept.current : null
  if (resource.kind === "loaded") return { kind: "loaded", data: resource.data, refreshFailed: null }
  if (last === null) return resource
  return { kind: "loaded", data: last.data, refreshFailed: resource.kind === "failed" ? resource.error : null }
}

/** A refresh that failed while the page keeps showing what it had, with a retry. */
export function RefreshFailed({ title, error, onRetry }: { title: string; error: ApiError; onRetry(): void }) {
  return (
    <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <span>{title}: {error.message} What's shown may be out of date.</span>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}><RefreshCw />Retry</Button>
    </div>
  )
}

/** The links between a comment window's pages; every page is an absolute route from `to`. */
export function CommentPager({ window, current, label, to }: { window: CommentWindow; current: string; label: string; to(cursor: string | null): string }) {
  if (!current && !window.page.has_more) return null
  const pageLink = "rounded-md border px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return (
    <nav aria-label={label} className="mt-4 flex flex-wrap gap-3">
      {current && <Link to={to(null)} className={pageLink}>First page</Link>}
      {window.previous_cursor && <Link to={to(window.previous_cursor)} className={pageLink}>Previous page</Link>}
      {window.page.next_cursor && <Link to={to(window.page.next_cursor)} className={pageLink}>Next page</Link>}
    </nav>
  )
}

/**
 * What this page's own edits and removals answered, by comment id, so each
 * shows at once wherever the comment is listed, whichever window answer is
 * current. Every completed write also bumps `token`, which the page passes
 * to its read as a revalidation and stamps on that read's answer: a write's
 * answer stands over a window read before it (`readToken` below its own),
 * and gives way to any read that started after it, which already holds it.
 */
export type WrittenComments = {
  token: number
  record(comment: ThreadComment): void
  current(comment: ThreadComment, readToken: number): ThreadComment
}

export function useWrittenComments(): WrittenComments {
  const seq = useRef(0)
  const [state, setState] = useState<{ token: number; written: Record<string, { comment: ThreadComment; seq: number }> }>({ token: 0, written: {} })
  return {
    token: state.token,
    record(comment) {
      const at = ++seq.current
      setState((latest) => ({ token: at, written: { ...latest.written, [comment.id]: { comment, seq: at } } }))
    },
    current(comment, readToken) {
      const written = state.written[comment.id]
      return written && written.seq > readToken ? written.comment : comment
    },
  }
}

/** A comment window as a list of cards, each shown as this page's latest write on it left it (see `WrittenComments`). */
export function CommentItems<Status extends string>({ repo, config, thread, window, readToken, written, label, focused, onPosted }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  window: CommentWindow
  /** The `written.token` the window's read started at. */
  readToken: number
  written: WrittenComments
  label: string
  focused: string | null
  onPosted(posted: CommentPermalink): void
}) {
  const { viewer } = useSession()
  return (
    <ol aria-label={label} className="space-y-3">
      {window.items.map((item) => (
        <li key={item.id}>
          <CommentCard repo={repo} config={config} thread={thread} comment={written.current(item, readToken)} viewer={viewer?.name ?? null} focused={focused === item.id}
            onPosted={onPosted} onChanged={written.record} />
        </li>
      ))}
    </ol>
  )
}

/**
 * A thread's comments on its own page: one window of them, oldest first
 * (`?comments=<cursor>` in the URL keeps the page), each with its reply
 * context, and a composer for a new comment when Haxy says the viewer may
 * comment. A posted comment opens in the window that holds it.
 */
export function ThreadComments<Status extends string>({ repo, config, thread, onLoaded, refresh = 0 }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  /** Called with when each read that succeeds went out (`nextReadOrder`). */
  onLoaded?(startedAt: number): void
  /** Reads the comments again whenever it changes. */
  refresh?: number
}) {
  const { viewer, viewerKey } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const cursor = params.get("comments") ?? ""
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  // what the viewer may do is part of the answer; each navigation reads it again
  const written = useWrittenComments()
  // each navigation, and each write that completes here, reads the window again
  const readToken = written.token
  const resourceKey = `comments ${key} ${thread} ${cursor} ${viewerKey}`
  const read = useResource(resourceKey, (signal) => {
    const startedAt = nextReadOrder()
    return listComments(repo, config.kind, thread, { cursor: cursor || undefined }, { signal }).then((data) => ({ ...data, readToken, startedAt }))
  }, `${location.key} ${readToken} ${refresh}`)
  const loadedFrom = read.kind === "loaded" ? read.data.startedAt : null
  useEffect(() => {
    if (loadedFrom !== null) onLoaded?.(loadedFrom)
  }, [loadedFrom])
  // a refresh that fails keeps the cards and every open draft
  const comments = useKept(read, resourceKey)
  const focused = useFocusedComment(comments.kind === "loaded" ? comments.data.items : null)
  const opened = (posted: CommentPermalink) => void navigate(threadCommentsRoute(repo, config.kind, thread, posted.thread_cursor, posted.comment.id))
  const noun = config.noun.toLowerCase()

  let body
  switch (comments.kind) {
    case "loading":
      body = <LoadingState>Loading comments…</LoadingState>
      break
    case "failed":
      body = <FailureState title="Couldn't load the comments" error={comments.error} onRetry={read.reload} />
      break
    case "loaded": {
      const { data } = comments
      const create = data.actions.create
      body = (
        <>
          {comments.refreshFailed && <RefreshFailed title="Couldn't refresh the comments" error={comments.refreshFailed} onRetry={read.reload} />}
          {data.items.length === 0
            ? <p className="text-sm text-muted-foreground">{cursor ? "No comments on this page." : "No comments yet."}</p>
            : <CommentItems key={viewerKey} repo={repo} config={config} thread={thread} window={data} readToken={data.readToken} written={written} label="Comments" focused={focused} onPosted={opened} />}
          <CommentPager window={data} current={cursor} label="Comment pages" to={(next) => threadCommentsRoute(repo, config.kind, thread, next)} />
          <div className="mt-6">
            {create.available
              ? <CommentComposer key={viewerKey} repo={repo} config={config} thread={thread} parent={null} viewer={viewer?.name ?? null} label="New comment" submitLabel="Comment" onPosted={opened} />
              : (
                <p className="text-sm text-muted-foreground">
                  {create.reason.code === "unauthenticated"
                    ? <><Link to={loginPath(location.pathname + location.search)} className={linkClass}>Log in</Link> to comment on this {noun}.</>
                    : create.reason.message}
                </p>
              )}
          </div>
        </>
      )
      break
    }
  }
  const count = comments.kind === "loaded" ? comments.data.page.count : null
  return (
    <section aria-labelledby="thread-comments" className="mt-8">
      <h3 id="thread-comments" className="mb-3 text-sm font-semibold">
        Comments{count && count.kind !== "unknown" ? ` (${count.value}${count.kind === "at_least" ? "+" : ""})` : ""}
      </h3>
      {body}
    </section>
  )
}
