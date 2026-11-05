import { useId, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { LoaderCircle, MessageSquarePlus, RefreshCw, Save } from "lucide-react"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { useLatest } from "@/pages/settings/shared"
import { ApiError } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { editComment, findComment, getComment, holdsBody, newCommentId, postComment, type CommentPermalink, type ThreadComment } from "@/lib/comments"
import type { WriteViewer } from "@/lib/threads"
import type { ThreadConfig } from "./config"

// The forms that write comments: a new comment or reply (CommentComposer),
// and an edit of one (CommentEditor). Each holds itself while a write is
// pending, ignores the later clicks of a double click, keeps the text on any
// failure, and settles an outcome Haxy couldn't confirm by reading the
// comment again before offering another attempt (docs/api-conventions.md,
// "Comments").

const textareaClass =
  "mt-1.5 block min-h-28 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-60"

function BodyField({ label, value, onValue, error, disabled, autoFocus }: { label: string; value: string; onValue(value: string): void; error?: string; disabled: boolean; autoFocus?: boolean }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <textarea id={id} name="body" className={textareaClass} value={value} onChange={(event) => onValue(event.target.value)} disabled={disabled} autoFocus={autoFocus}
        aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">Markdown, as Haxy renders it.</p>
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

const lead = (cause: string) => `Haxy couldn't confirm what happened to this request (${cause}).`

/**
 * A post whose outcome is unknown (timeout, lost connection, internal error,
 * unreadable answer), or that Haxy refused because the composer's id is
 * taken. The composer sends the id it posts under, so what happened can be
 * read back exactly: a comment with that id exists (perhaps removed since),
 * or it doesn't and the same post can be sent again — Haxy refuses a second
 * comment with that id, so a retry can't post twice.
 */
type Uncertain = { cause: string; check: "checking" | "missing" | "removed" | "unchecked" }

/**
 * Posts a comment on the thread, or a reply to `parent`. `onPosted` gets the
 * new comment as Haxy answered (or found) it.
 */
export function CommentComposer<Status extends string>({ repo, config, thread, parent, viewer, label, submitLabel, autoFocus, onPosted, onCancel }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  parent: string | null
  viewer: WriteViewer
  /** The form's accessible name and the field's label. */
  label: string
  submitLabel: string
  autoFocus?: boolean
  onPosted(posted: CommentPermalink): void
  onCancel?(): void
}) {
  // one id for everything this composer submits: every attempt is the same post
  const [id, setId] = useState(newCommentId)
  const [body, setBody] = useState("")
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [uncertain, setUncertain] = useState<Uncertain | null>(null)
  const latest = useLatest()
  // React state updates after the first click, so a double click would
  // otherwise submit twice before `pending` arrives
  const submitting = useRef(false)
  if (!pending) submitting.current = false

  function posted(answer: CommentPermalink) {
    setId(newCommentId())
    setBody("")
    setUncertain(null)
    onPosted(answer)
  }

  async function check(cause: string) {
    const started = latest.begin()
    setUncertain({ cause, check: "checking" })
    let found: CommentPermalink | null
    try {
      found = await findComment(repo, config.kind, thread, id)
    } catch {
      if (latest.isLatest(started)) setUncertain({ cause, check: "unchecked" })
      return
    }
    if (!latest.isLatest(started)) return
    if (found === null) setUncertain({ cause, check: "missing" })
    else if (found.comment.removed) setUncertain({ cause, check: "removed" })
    else posted(found)
  }

  // the text, as a comment of its own under a new id
  function startAfresh() {
    latest.begin()
    setId(newCommentId())
    setUncertain(null)
  }

  async function submit() {
    // a retry is offered only once a check found nothing posted
    if (pending || submitting.current || (uncertain !== null && uncertain.check !== "missing")) return
    submitting.current = true
    const started = latest.begin()
    setPending(true)
    setFailure(null)
    try {
      const answer = await postComment(repo, config.kind, thread, viewer, id, parent, body)
      if (latest.isLatest(started)) {
        setPending(false)
        posted(answer)
      }
    } catch (error) {
      if (!latest.isLatest(started)) return
      setPending(false)
      // the id is this composer's own: taken means an earlier attempt posted it
      const failed = failureOf(error, "Posting the comment failed.")
      if (!failed.viewerChanged && error instanceof ApiError && error.code === "conflict" && error.fieldError("id") !== undefined) return void (await check(uncertain?.cause ?? error.message))
      if (failed.unknown) await check(failed.cause)
      else {
        setUncertain(null)
        setFailure(failed)
      }
    }
  }

  const blocked = uncertain !== null && uncertain.check !== "missing"
  let notice: ReactNode = null
  if (uncertain) {
    switch (uncertain.check) {
      case "checking":
        notice = <>{lead(uncertain.cause)} Checking whether the comment was posted…</>
        break
      case "missing":
        notice = <>{lead(uncertain.cause)} Haxy has no comment from it yet, so nothing was posted. Post the same text again; Haxy won't post it twice.</>
        break
      case "removed":
        notice = (
          <>
            The comment was posted and then removed (perhaps by someone else). Your text is kept below.
            <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={startAfresh}><MessageSquarePlus />Post it as a new comment</Button>
          </>
        )
        break
      case "unchecked":
        notice = (
          <>
            {lead(uncertain.cause)} Haxy couldn't say whether the comment was posted either, so check before trying again.
            <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={() => void check(uncertain.cause)}><RefreshCw />Check again</Button>
          </>
        )
        break
    }
  }
  return (
    <form aria-label={label} className="mt-3 space-y-3" noValidate onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {failure && <FailureMessage failure={failure} />}
      {notice && <FormMessage kind="error"><span>{notice}</span></FormMessage>}
      {/* while an attempt's outcome is unsettled it may still land, so a retry must send exactly its text */}
      <BodyField label={label} value={body} onValue={setBody} error={failure?.fields.body} disabled={pending || uncertain !== null} autoFocus={autoFocus} />
      <div className="flex gap-2">
        {/* the later clicks of a double click don't submit again, even once the first has settled */}
        <Button type="submit" size="sm" disabled={pending || blocked} onClick={(event) => { if (event.detail > 1) event.preventDefault() }}>
          {pending ? <LoaderCircle className="animate-spin" /> : <MessageSquarePlus />}{submitLabel}
        </Button>
        {onCancel && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  )
}

/**
 * What stands in the way of saving an edit: an outcome Haxy couldn't
 * confirm, being settled by reading the comment again; someone else's change
 * since the editor opened (`conflict` on the revision), which the user must
 * look at before replacing it; or the comment's removal.
 */
type Notice =
  | { kind: "checking"; cause: string }
  | { kind: "unchecked"; cause: string }
  | { kind: "unsaved"; cause: string }
  | { kind: "stale" }
  | { kind: "reviewing"; current: ThreadComment }
  | { kind: "removed" }

/** Replaces a comment's body, as of the revision it was loaded at. `onSaved` gets the comment as Haxy now has it. */
export function CommentEditor<Status extends string>({ repo, config, thread, comment, viewer, onSaved, onCancel }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: string
  comment: ThreadComment
  viewer: WriteViewer
  onSaved(comment: ThreadComment): void
  onCancel(): void
}) {
  // the revision the next save replaces; it moves only when the user has seen what it holds
  const [revision, setRevision] = useState(comment.revision)
  const [body, setBody] = useState(comment.body_text)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const latest = useLatest()
  const submitting = useRef(false)
  if (!pending) submitting.current = false

  // An unknown outcome: the comment now holding exactly what was sent means
  // the save landed; still at the revision it was made against means it
  // didn't; anything else is someone else's change, to review first.
  async function settle(cause: string, sent: string) {
    const started = latest.begin()
    setNotice({ kind: "checking", cause })
    let current: CommentPermalink | null
    try {
      current = await findComment(repo, config.kind, thread, comment.id)
    } catch {
      if (latest.isLatest(started)) setNotice({ kind: "unchecked", cause })
      return
    }
    if (!latest.isLatest(started)) return
    if (current === null) setFailure({ message: "This comment's thread is gone.", cause, fields: {}, unknown: false, viewerChanged: false })
    else if (current.comment.removed) setNotice({ kind: "removed" })
    else if (holdsBody(current.comment, sent)) onSaved(current.comment)
    else if (current.comment.revision === revision) setNotice({ kind: "unsaved", cause })
    else setNotice({ kind: "stale" })
  }

  async function review() {
    const started = latest.begin()
    try {
      const current = await getComment(repo, config.kind, thread, comment.id)
      if (!latest.isLatest(started)) return
      if (current.comment.removed) return setNotice({ kind: "removed" })
      setRevision(current.comment.revision)
      setNotice({ kind: "reviewing", current: current.comment })
    } catch (error) {
      if (latest.isLatest(started)) setFailure(failureOf(error, "Loading the comment failed."))
    }
  }

  async function submit() {
    if (pending || submitting.current || (notice !== null && notice.kind !== "unsaved" && notice.kind !== "reviewing")) return
    submitting.current = true
    const started = latest.begin()
    setPending(true)
    setFailure(null)
    setNotice(null)
    try {
      const saved = await editComment(repo, config.kind, thread, comment.id, viewer, revision, body)
      if (latest.isLatest(started)) {
        setPending(false)
        onSaved(saved.comment)
      }
    } catch (error) {
      if (!latest.isLatest(started)) return
      setPending(false)
      const failed = failureOf(error, "Saving the comment failed.")
      // someone else signed in meanwhile (another tab) is no conflict of the
      // comment's: it is reported as such, with a reload
      if (!failed.viewerChanged && error instanceof ApiError && error.code === "conflict") {
        setNotice(error.fieldError("revision") !== undefined ? { kind: "stale" } : { kind: "removed" })
        return
      }
      if (failed.unknown) await settle(failed.cause, body)
      else setFailure(failed)
    }
  }

  let message: ReactNode = null
  if (notice) {
    switch (notice.kind) {
      case "checking":
        message = <FormMessage kind="error">{lead(notice.cause)} Checking the comment…</FormMessage>
        break
      case "unchecked":
        message = (
          <FormMessage kind="error">
            <p>{lead(notice.cause)} Haxy couldn't say whether the comment changed either.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void review()}><RefreshCw />Check the comment</Button>
          </FormMessage>
        )
        break
      case "unsaved":
        message = <FormMessage kind="error">{lead(notice.cause)} The comment is unchanged, so nothing was saved; save again to try once more.</FormMessage>
        break
      case "stale":
        message = (
          <FormMessage kind="error">
            <p>Someone changed this comment since you started editing it, so your changes weren't saved. They're kept below.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void review()}><RefreshCw />Show the current version</Button>
          </FormMessage>
        )
        break
      case "reviewing":
        message = (
          <section aria-label="Current version" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
            <p>This is the comment as it is now. Saving replaces it with your text.</p>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{notice.current.body_text}</pre>
          </section>
        )
        break
      case "removed":
        message = <FormMessage kind="error">This comment has been removed, so it can't be edited. Your text is kept below.</FormMessage>
        break
    }
  }
  const blocked = notice !== null && notice.kind !== "unsaved" && notice.kind !== "reviewing"
  return (
    <form aria-label="Edit comment" className="mt-3 space-y-3" noValidate onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {failure && <FailureMessage failure={failure} />}
      {message}
      <BodyField label="Comment" value={body} onValue={setBody} error={failure?.fields.body} disabled={pending || (blocked && notice?.kind !== "removed")} autoFocus />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || blocked} onClick={(event) => { if (event.detail > 1) event.preventDefault() }}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}Save comment
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
