import { Link, useLocation, useNavigate, useSearchParams } from "react-router"
import { ArrowLeft } from "lucide-react"
import { FailureState, LoadingState } from "@/components/listing"
import { useSession } from "@/app/session"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { commentRoute, getComment, threadCommentsRoute, type CommentPermalink } from "@/lib/comments"
import { getThread, threadRoute } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { CommentCard } from "./CommentCard"
import { SectionUnavailable } from "./ThreadParts"
import { CommentItems, CommentPager, RefreshFailed, useKept, useWrittenComments, type WrittenComments } from "./ThreadComments"

/**
 * `<repo>/<kind>/<id>/comments/<comment>`: a comment's own page, as the TUI's
 * comment permalink shows it — the comment with its reply context (who it
 * replies to, linking that comment's page) and a window of its immediate
 * replies (`?replies=<cursor>` keeps the page), plus a link to it in its
 * thread's comments, at the page that holds it.
 */
export function CommentPermalinkView<Status extends string>({ repo, config, thread, comment, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; thread: string; comment: string; unavailable: string | null }) {
  const { viewerKey } = useSession()
  const location = useLocation()
  const [params] = useSearchParams()
  const cursor = params.get("replies") ?? ""
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const noun = config.noun.toLowerCase()
  // the thread's title heads the page; what the viewer may do is part of the answers
  // each navigation, and each write that completes here, reads the page again
  const written = useWrittenComments()
  const readToken = written.token
  const resourceKey = `comment ${key} ${thread} ${comment} ${cursor} ${viewerKey}`
  const read = useResource(
    resourceKey,
    (signal) => Promise.all([getThread<Status>(repo, config.kind, thread, { signal }), getComment(repo, config.kind, thread, comment, { cursor: cursor || undefined }, { signal }), readToken] as const),
    `${location.key} ${readToken}`,
  )
  // only the first load may replace the page; a refresh that fails keeps every open draft
  const loaded = useKept(read, resourceKey)
  switch (loaded.kind) {
    case "loading":
      return <LoadingState>Loading the comment…</LoadingState>
    case "failed":
      if (loaded.error.code === "not_found") {
        if (unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
        return (
          <section className="mt-6">
            <h2 className="text-2xl font-semibold tracking-tight">Comment not found</h2>
            <p className="mt-2 text-muted-foreground">There is no such comment on this {noun}, or the {noun} has been removed.</p>
            <Link to={threadRoute(repo, config.kind, thread)} className={`mt-4 inline-block text-sm ${linkClass}`}>Open the {noun}</Link>
          </section>
        )
      }
      return <FailureState title="Couldn't load this comment" error={loaded.error} onRetry={read.reload} />
    case "loaded": {
      const [detail, permalink, readAt] = loaded.data
      return (
        <>
          {loaded.refreshFailed && <div className="mt-6"><RefreshFailed title="Couldn't refresh this comment" error={loaded.refreshFailed} onRetry={read.reload} /></div>}
          <Permalink key={viewerKey} repo={repo} config={config} title={detail.title} thread={thread} permalink={permalink} readToken={readAt} written={written} cursor={cursor} />
        </>
      )
    }
  }
}

function Permalink<Status extends string>({ repo, config, title, thread, permalink, readToken, written, cursor }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  title: string
  thread: string
  permalink: CommentPermalink
  readToken: number
  written: WrittenComments
  cursor: string
}) {
  const { viewer } = useSession()
  const navigate = useNavigate()
  const selected = written.current(permalink.comment, readToken)
  const opened = (posted: CommentPermalink) => void navigate(threadCommentsRoute(repo, config.kind, thread, posted.thread_cursor, posted.comment.id))
  const replies = permalink.replies
  const count = replies.page.count.kind === "unknown" ? null : replies.page.count.value
  return (
    <article className="mt-6">
      <Link to={threadCommentsRoute(repo, config.kind, thread, permalink.thread_cursor, selected.id)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
        <ArrowLeft size={14} aria-hidden />Show in the {config.noun.toLowerCase()}'s comments
      </Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">Comment on <Link to={threadRoute(repo, config.kind, thread)} className={linkClass}>{title}</Link></h2>
      <div className="mt-4">
        <CommentCard repo={repo} config={config} thread={thread} comment={selected} viewer={viewer?.name ?? null} focused
          onChanged={written.record} onPosted={opened} />
      </div>
      <section aria-labelledby="comment-replies" className="mt-6 ml-4 border-l pl-4 sm:ml-8">
        <h3 id="comment-replies" className="mb-3 text-sm font-semibold">{count === null ? "Replies" : `${count} ${count === 1 ? "reply" : "replies"}`}</h3>
        {replies.items.length > 0 && <CommentItems repo={repo} config={config} thread={thread} window={replies} readToken={readToken} written={written} label="Replies" focused={null} onPosted={opened} />}
        <CommentPager window={replies} current={cursor} label="Reply pages" to={(next) => commentRoute(repo, config.kind, thread, selected.id, next)} />
      </section>
    </article>
  )
}
