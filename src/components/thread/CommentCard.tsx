import { useState, type MouseEvent } from "react"
import { Link } from "react-router"
import { CornerDownRight, LoaderCircle, Pencil, Reply, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { Markdown } from "@/components/Markdown"
import { useWrite } from "@/pages/settings/shared"
import { linkTarget } from "@/lib/markdown"
import type { RepoLocator } from "@/lib/repo"
import { commentAnchor, commentRoute, findComment, removeComment, type CommentPermalink, type ThreadComment } from "@/lib/comments"
import type { WriteViewer } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { CommentComposer, CommentEditor } from "./CommentForms"
import { AuthorName } from "./ThreadParts"

// a click that continues a double (or triple) click; keyboard activation is 0
const repeated = (event: MouseEvent) => event.detail > 1

function When({ value }: { value: string }) {
  const date = new Date(value)
  return <time dateTime={value} title={value}>{date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
}

/**
 * One comment: who wrote it and, for a reply, who it replies to (a link to
 * that comment's page); when, as a link to its own page; its body, or that it
 * was removed; and the actions Haxy says the viewer may take — reply, edit,
 * remove (asked first). `focused` marks the comment a link points at.
 */
export function CommentCard<Status extends string>({ repo, config, thread, comment, viewer, focused = false, onChanged, onPosted }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  comment: ThreadComment
  viewer: WriteViewer
  focused?: boolean
  /** The comment as Haxy now has it, after an edit or a removal. */
  onChanged(comment: ThreadComment): void
  /** A reply was posted. */
  onPosted(posted: CommentPermalink): void
}) {
  const [mode, setMode] = useState<"view" | "reply" | "edit" | "confirm-remove">("view")
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const removal = useWrite<string>()
  const { actions } = comment
  const permalink = commentRoute(repo, config.kind, thread, comment.id)

  const remove = () => removal.start(async (current) => {
    setFailure(null)
    setNotice(null)
    try {
      const answer = await removeComment(repo, config.kind, thread, comment.id, viewer)
      if (!current()) return
      setMode("view")
      onChanged(answer.comment)
    } catch (error) {
      if (!current()) return
      const failed = failureOf(error, "Removing the comment failed.")
      if (!failed.unknown) return setFailure(failed)
      // removing it again changes nothing, so the comment as it is now settles it
      try {
        const found = await findComment(repo, config.kind, thread, comment.id)
        if (!current()) return
        if (found === null) return setFailure({ ...failed, message: "This comment's thread is gone." })
        setMode("view")
        onChanged(found.comment)
        if (!found.comment.removed) setNotice(`Haxy couldn't confirm what happened to this request (${failed.cause}). The comment is still there; remove it again to try once more.`)
      } catch {
        if (current()) setFailure(failed)
      }
    }
  })

  return (
    <article id={commentAnchor(comment.id)} tabIndex={-1} aria-label={`Comment by ${authorText(comment)}`} data-focused={focused || undefined}
      className={`scroll-mt-24 rounded-xl border bg-card p-4 outline-none ${focused ? "border-primary ring-2 ring-primary/30" : ""}`}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <span className="font-medium text-foreground"><AuthorName author={comment.author} /></span>
        {comment.parent_id && (
          <Link to={commentRoute(repo, config.kind, thread, comment.parent_id)} className={`inline-flex items-center gap-1 ${linkClass}`}>
            <CornerDownRight size={14} aria-hidden />replying to {comment.parent_author ? authorName(comment.parent_author) : "a comment"}
          </Link>
        )}
        <Link to={permalink} className={linkClass} aria-label="Permalink"><When value={comment.created_at} /></Link>
      </header>
      {mode === "edit" ? (
        <CommentEditor repo={repo} config={config} thread={thread} comment={comment} viewer={viewer} onCancel={() => setMode("view")}
          onSaved={(saved) => { setMode("view"); onChanged(saved) }} />
      ) : (
        <div className="mt-2">
          {comment.removed
            ? <p className="text-sm italic text-muted-foreground">(removed)</p>
            : <Markdown blocks={comment.body} resolveLink={(destination) => linkTarget(destination, repo.kind === "local")} />}
        </div>
      )}
      {failure && <div className="mt-3"><FailureMessage failure={failure} /></div>}
      {notice && <div className="mt-3"><FormMessage kind="error">{notice}</FormMessage></div>}
      {mode === "view" && (actions.reply.available || actions.edit.available || actions.remove.available) && (
        <div role="group" aria-label="Comment actions" className="mt-3 flex flex-wrap gap-2">
          {actions.reply.available && <Button type="button" variant="ghost" size="sm" onClick={(event) => { if (!repeated(event)) setMode("reply") }}><Reply />Reply</Button>}
          {actions.edit.available && <Button type="button" variant="ghost" size="sm" disabled={removal.busy} onClick={(event) => { if (!repeated(event)) { setFailure(null); setMode("edit") } }}><Pencil />Edit</Button>}
          {actions.remove.available && <Button type="button" variant="ghost" size="sm" disabled={removal.busy} onClick={(event) => { if (!repeated(event)) { setFailure(null); setMode("confirm-remove") } }}><Trash2 />Remove</Button>}
        </div>
      )}
      {mode === "confirm-remove" && (
        <section role="alertdialog" aria-label="Remove this comment?" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm">Remove this comment? It shows as removed for everyone; its replies stay.</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={removal.busy} onClick={(event) => { if (!repeated(event)) void remove() }}>
              {removal.busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Remove comment
            </Button>
            <Button type="button" variant="outline" size="sm" autoFocus disabled={removal.busy} onClick={() => setMode("view")}>Cancel</Button>
          </div>
        </section>
      )}
      {mode === "reply" && (
        <CommentComposer repo={repo} config={config} thread={thread} parent={comment.id} viewer={viewer} label="Reply" submitLabel="Post reply" autoFocus
          onCancel={() => setMode("view")} onPosted={(posted) => { setMode("view"); onPosted(posted) }} />
      )}
    </article>
  )
}

function authorName(author: ThreadComment["author"]): string {
  switch (author.kind) {
    case "user": return author.name
    case "email": return author.email
    case "unknown": return "someone"
  }
}

function authorText(comment: ThreadComment): string {
  return authorName(comment.author)
}
