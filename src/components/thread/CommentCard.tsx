import { useState, type MouseEvent, type ReactNode } from "react"
import { Link } from "react-router"
import { CornerDownRight, LoaderCircle, MessageSquareReply, Pencil, Trash2 } from "lucide-react"
import { Avatar } from "@/components/Avatar"
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
import { CommentMenu, type CommentMenuAction } from "./CommentMenu"
import { AuthorName, authorText } from "./ThreadParts"

// a click that continues a double (or triple) click; keyboard activation is 0
const repeated = (event: MouseEvent) => event.detail > 1

type Mode = "view" | "reply" | "edit" | "confirm-remove"

function When({ value }: { value: string }) {
  const date = new Date(value)
  return <time dateTime={value} title={value}>{date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
}

/** Removes the comment; an outcome Haxy couldn't confirm is settled by reading the comment again. */
function useRemoval<Status extends string>({ repo, config, thread, comment, viewer, onChanged, done }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  comment: ThreadComment
  viewer: WriteViewer
  onChanged(comment: ThreadComment): void
  done(): void
}) {
  const write = useWrite<string>()
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const settle = async (failed: Failure, current: () => boolean) => {
    // removing it again changes nothing, so the comment as it is now settles it
    try {
      const found = await findComment(repo, config.kind, thread, comment.id)
      if (!current()) return
      if (found === null) return setFailure({ ...failed, message: "This comment's thread is gone." })
      done()
      onChanged(found.comment)
      if (!found.comment.removed) setNotice(`Haxy couldn't confirm what happened to this request (${failed.cause}). The comment is still there; remove it again to try once more.`)
    } catch {
      if (current()) setFailure(failed)
    }
  }
  const remove = () => write.start(async (current) => {
    setFailure(null)
    setNotice(null)
    try {
      const answer = await removeComment(repo, config.kind, thread, comment.id, viewer)
      if (!current()) return
      done()
      onChanged(answer.comment)
    } catch (error) {
      if (!current()) return
      const failed = failureOf(error, "Removing the comment failed.")
      if (failed.unknown) await settle(failed, current)
      else setFailure(failed)
    }
  })
  return { busy: write.busy, failure, notice, remove, clearFailure: () => setFailure(null) }
}

function CommentText({ comment, local }: { comment: ThreadComment; local: boolean }) {
  if (comment.removed) return <p className="text-sm italic text-muted-foreground">(removed)</p>
  return <Markdown blocks={comment.body} resolveLink={(destination) => linkTarget(destination, local)} />
}

function ReplyContext({ to, author }: { to: string; author: ThreadComment["parent_author"] }) {
  return (
    <Link to={to} className={`inline-flex items-center gap-1 ${linkClass}`}>
      <CornerDownRight size={14} aria-hidden />replying to {author ? authorText(author) : "a comment"}
    </Link>
  )
}

function CommentHeader({ comment, nested, permalink, parent, menu }: { comment: ThreadComment; nested: boolean; permalink: string; parent: string | null; menu: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <Avatar name={authorText(comment.author)} size={nested ? "sm" : "md"} />
      <span className="font-medium text-foreground"><AuthorName author={comment.author} /></span>
      <span aria-hidden>·</span>
      <Link to={permalink} className={linkClass} aria-label="Permalink"><When value={comment.created_at} /></Link>
      {parent && <ReplyContext to={parent} author={comment.parent_author} />}
      <div className="ml-auto">{menu}</div>
    </header>
  )
}

function RemoveConfirmation({ busy, onRemove, onCancel }: { busy: boolean; onRemove(): void; onCancel(): void }) {
  return (
    <section role="alertdialog" aria-label="Remove this comment?" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <p className="text-sm">Remove this comment? It shows as removed for everyone; its replies stay.</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={(event) => { if (!repeated(event)) onRemove() }}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Remove comment
        </Button>
        <Button type="button" variant="outline" size="sm" autoFocus disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  )
}

function ReplyButton({ onReply }: { onReply(): void }) {
  return (
    <button type="button" onClick={(event) => { if (!repeated(event)) onReply() }}
      className="mt-2 inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      <MessageSquareReply size={14} aria-hidden />Reply
    </button>
  )
}

type Anchor = { id: string; tabIndex: number; "aria-label": string; "data-focused"?: boolean }

/** A top-level comment's card, holding its replies; a nested one is a row in such a card. */
function CommentFrame({ anchor, nested, focused, header, body, rest, replies }: { anchor: Anchor; nested: boolean; focused: boolean; header: ReactNode; body: ReactNode; rest: ReactNode; replies: ReactNode }) {
  if (nested) {
    return (
      <article {...anchor} className={`scroll-mt-24 px-4 py-3 outline-none sm:px-5 ${focused ? "bg-accent/50 ring-2 ring-primary/30 ring-inset" : ""}`}>
        {header}
        <div className="mt-1.5 pl-7 text-sm">{body}{rest}</div>
      </article>
    )
  }
  return (
    <div className={`overflow-hidden rounded-xl border bg-card shadow-xs ${focused ? "border-primary ring-2 ring-primary/30" : ""}`}>
      <article {...anchor} className="scroll-mt-24 p-4 outline-none sm:px-5">
        {header}
        <div className="mt-3">{body}</div>
        {rest}
      </article>
      {replies}
    </div>
  )
}

function menuActions(comment: ThreadComment, busy: boolean, edit: () => void, remove: () => void): CommentMenuAction[] {
  const { actions } = comment
  return [
    ...(actions.edit.available ? [{ label: "Edit", icon: Pencil, disabled: busy, run: edit }] : []),
    ...(actions.remove.available ? [{ label: "Remove", icon: Trash2, disabled: busy, destructive: true, run: remove }] : []),
  ]
}

/**
 * One comment: who wrote it and when (a link to its own page); for a reply
 * whose `showsParent`, who it replies to (a link to that comment's page);
 * its body, or that it was removed; a Reply button and a ⋯ menu with the
 * other actions Haxy says the viewer may take — edit, remove (asked first).
 * A top-level comment is a card, holding `replies` below it; a `nested` one
 * is a row in such a card. `focused` marks the comment a link points at.
 */
export function CommentCard<Status extends string>({ repo, config, thread, comment, viewer, focused = false, nested = false, showsParent = comment.parent_id !== null, replies, onChanged, onPosted }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  comment: ThreadComment
  viewer: WriteViewer
  focused?: boolean
  nested?: boolean
  showsParent?: boolean
  replies?: ReactNode
  /** The comment as Haxy now has it, after an edit or a removal. */
  onChanged(comment: ThreadComment): void
  /** A reply was posted. */
  onPosted(posted: CommentPermalink): void
}) {
  const [mode, setMode] = useState<Mode>("view")
  const removal = useRemoval({ repo, config, thread, comment, viewer, onChanged, done: () => setMode("view") })
  const parent = showsParent && comment.parent_id ? commentRoute(repo, config.kind, thread, comment.parent_id) : null
  const viewing = mode === "view"
  const choose = (next: Mode) => () => { removal.clearFailure(); setMode(next) }
  const menu = viewing && <CommentMenu actions={menuActions(comment, removal.busy, choose("edit"), choose("confirm-remove"))} />
  const body = mode === "edit"
    ? <CommentEditor repo={repo} config={config} thread={thread} comment={comment} viewer={viewer} onCancel={() => setMode("view")} onSaved={(saved) => { setMode("view"); onChanged(saved) }} />
    : <CommentText comment={comment} local={repo.kind === "local"} />
  const rest = (
    <>
      {removal.failure && <div className="mt-3"><FailureMessage failure={removal.failure} /></div>}
      {removal.notice && <div className="mt-3"><FormMessage kind="error">{removal.notice}</FormMessage></div>}
      {mode === "confirm-remove" && <RemoveConfirmation busy={removal.busy} onRemove={() => void removal.remove()} onCancel={() => setMode("view")} />}
      {viewing && comment.actions.reply.available && <ReplyButton onReply={() => setMode("reply")} />}
      {mode === "reply" && (
        <CommentComposer repo={repo} config={config} thread={thread} parent={comment.id} viewer={viewer} label="Reply" submitLabel="Post reply" autoFocus
          onCancel={() => setMode("view")} onPosted={(posted) => { setMode("view"); onPosted(posted) }} />
      )}
    </>
  )
  const anchor = { id: commentAnchor(comment.id), tabIndex: -1, "aria-label": `Comment by ${authorText(comment.author)}`, "data-focused": focused || undefined }
  const header = <CommentHeader comment={comment} nested={nested} permalink={commentRoute(repo, config.kind, thread, comment.id)} parent={parent} menu={menu} />
  return <CommentFrame anchor={anchor} nested={nested} focused={focused} header={header} body={body} rest={rest} replies={replies} />
}
