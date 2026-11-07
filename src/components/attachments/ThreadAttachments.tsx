import { useCallback, useRef, useState, type FormEvent, type MouseEvent } from "react"
import { useNavigate } from "react-router"
import { FileText, Image, LoaderCircle, Paperclip, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { ApiError } from "@/lib/api"
import { alreadyAttached, attachmentUrl, formatBytes, refusal, removeAttachment, uploadAttachment, type Attached, type ThreadAttachment } from "@/lib/attachments"
import type { RepoLocator } from "@/lib/repo"
import { findThread, newThreadId, threadsRoute, type ThreadDetail, type ThreadKind, type WriteViewer } from "@/lib/threads"
import { readStart, type ThreadReads } from "@/components/assignees/useThreadAnswers"
import { useWrite } from "@/pages/settings/shared"
import { Unresolved } from "@/pages/settings/Unresolved"
import { linkClass, type ThreadConfig } from "@/components/thread/config"
import { ThreadPanel, type PanelFrame } from "@/components/thread/ThreadPanel"

/**
 * A write whose outcome Haxy couldn't confirm, and that reading the thread
 * couldn't settle either; or a write known to be done (`done` says how)
 * whose thread couldn't be read again, so the attachments shown may be stale.
 */
type Unknown =
  | { action: "upload"; name: string; id: string; cause: string }
  | { action: "remove"; attachment: ThreadAttachment; cause: string }
  | { action: "refresh"; done: string }
  // an upload refused as a repeat: an earlier attempt landed, which the read may show since removed
  | { action: "landed"; name: string; id: string }

function unresolvedMessage(unknown: Unknown): string {
  if (unknown.action === "refresh") return `${unknown.done} Haxy couldn't be reached to show the attachments as they are now; check again before changing them.`
  if (unknown.action === "landed") return `${unknown.name} was attached by an earlier attempt. Haxy couldn't be reached to show the attachments as they are now; check again before changing them.`
  return `Haxy couldn't confirm what happened to this request (${unknown.cause}), and couldn't be reached to check. Check again before changing the attachments.`
}

/** A link that opens an attachment in place (a safe image) or downloads it under its name. */
function AttachmentLink({ href, attachment, className = "" }: { href: string; attachment: ThreadAttachment; className?: string }) {
  return (
    <a href={href} className={`min-w-0 truncate ${linkClass} ${className}`} {...(attachment.inline ? { target: "_blank", rel: "noopener noreferrer" } : { download: attachment.name })}>
      {attachment.name}
    </a>
  )
}

function AttachmentIcon({ attachment }: { attachment: ThreadAttachment }) {
  const Icon = attachment.inline ? Image : FileText
  return <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
}

/** The attachments as links alone, each beside its kind's icon. */
function AttachmentList({ repo, kind, thread, attachments, noun }: { repo: RepoLocator; kind: ThreadKind; thread: string; attachments: ThreadAttachment[]; noun: string }) {
  if (attachments.length === 0) return <p className="text-sm text-muted-foreground">Nothing is attached to this {noun}.</p>
  return (
    <ul aria-label="Attached files" className="space-y-1.5">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="flex min-w-0 items-center gap-2 text-sm">
          <AttachmentIcon attachment={attachment} /><AttachmentLink href={attachmentUrl(repo, kind, thread, attachment.id)} attachment={attachment} />
        </li>
      ))}
    </ul>
  )
}

/** The file chosen for upload, with the id its upload (and every retry of it) is sent under. */
type Chosen = { file: File; id: string }

/**
 * A thread's attachments, oldest first, each a link to Haxy's download route
 * (which names the file and decides whether the browser shows it: only safe
 * images open in place); and, when Haxy says the viewer may (`actions`), a
 * way to attach a file and to remove each attachment, after confirming.
 * Haxy checks again when a write runs.
 *
 * A file is checked against the limits Haxy publishes before it is sent; the
 * upload streams the file itself, under an id chosen for it, so an outcome
 * Haxy couldn't confirm is settled by reading the thread (listed means
 * attached), and sending it again is safe. Whenever that read fails, the
 * controls hold until "Check again" gets an answer. Answers update only the
 * attachments (see `useThreadAnswers`).
 */
export function ThreadAttachments<Status extends string>({ repo, config, thread, viewer, onChanged, reads, frame = "section" }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  /** The thread (of any kind) as the page shows it. */
  thread: Pick<ThreadDetail<Status>, "id" | "status"> & Attached
  viewer: WriteViewer
  /** The thread as Haxy answered a change. */
  onChanged(thread: Attached): void
  /** Where a read that settles an outcome goes, ordered by when it started. */
  reads: ThreadReads<Attached>
  /** In the sidebar, the files show as a list of links, with the controls behind a toggle. */
  frame?: PanelFrame
}) {
  const navigate = useNavigate()
  const write = useWrite<Unknown>()
  const input = useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null)
  // a file input shown again is empty, so nothing stays chosen behind it
  const fileInput = useCallback((element: HTMLInputElement | null) => {
    input.current = element
    if (element === null) setChosen(null)
  }, [])

  const canAttach = thread.actions.attach.available
  if (!canAttach && thread.attachments.length === 0) return null
  const noun = config.noun.toLowerCase()
  const limits = thread.attachment_limits
  const listRoute = threadsRoute(repo, config.kind, config.statuses, thread.status)
  // a click that continues a double (or triple) click; keyboard activation is 0
  const repeated = (event: MouseEvent) => event.detail > 1

  function choose(file: File | null) {
    setFailure(null)
    setNotice(null)
    // a new file is a new upload, with an id of its own
    setChosen(file ? { file, id: newThreadId() } : null)
  }

  function clearChosen() {
    setChosen(null)
    if (input.current) input.current.value = ""
  }

  /** Reads the thread again and shows it: "gone" when it no longer exists, null when Haxy couldn't say. */
  async function reread(current: () => boolean): Promise<ThreadDetail<Status> | "gone" | null> {
    const startedAt = readStart(reads.clock)
    try {
      const now = await findThread<Status>(repo, config.kind, thread.id)
      if (!current()) return null
      if (now === null) {
        void navigate(listRoute)
        return "gone"
      }
      reads.onRead(now, startedAt)
      return now
    } catch {
      return null
    }
  }

  /** What a read after an unknown outcome says; false when Haxy couldn't say. */
  async function settle(unknown: Unknown, current: () => boolean): Promise<boolean> {
    const now = await reread(current)
    if (now === null) return false
    if (now === "gone" || !current()) return true
    if (unknown.action === "refresh") {
      setNotice({ kind: "success", text: unknown.done })
    } else if (unknown.action === "landed") {
      if (now.attachments.some((attachment) => attachment.id === unknown.id)) {
        clearChosen()
        setNotice({ kind: "success", text: `${unknown.name} is attached.` })
      } else {
        // its id stays taken, so the same file is a new upload from here on
        setChosen((chosen) => chosen && chosen.id === unknown.id ? { file: chosen.file, id: newThreadId() } : chosen)
        setNotice({ kind: "error", text: `${unknown.name} was attached, but has been removed since. Attach it again to upload it anew.` })
      }
    } else if (unknown.action === "upload") {
      if (now.attachments.some((attachment) => attachment.id === unknown.id)) {
        clearChosen()
        setNotice({ kind: "success", text: `${unknown.name} is attached.` })
      } else {
        // the same file keeps its id, so attaching it again can't attach it twice
        setNotice({ kind: "error", text: `Haxy couldn't confirm whether ${unknown.name} was attached (${unknown.cause}). It isn't attached now; attaching it again is safe.` })
      }
    } else if (now.attachments.some((attachment) => attachment.id === unknown.attachment.id)) {
      setNotice({ kind: "error", text: `Haxy couldn't confirm what happened to this request (${unknown.cause}). ${unknown.attachment.name} is still attached; remove it again to try once more.` })
    } else {
      setNotice({ kind: "success", text: `${unknown.attachment.name} was removed.` })
    }
    return true
  }

  /** Runs a write; an unknown outcome is settled by reading the thread, or left unresolved. */
  async function run(attempt: Extract<Unknown, { action: "upload" | "remove" }>, send: () => Promise<ThreadDetail<Status>>, settled: (error: unknown) => boolean, current: () => boolean) {
    setFailure(null)
    setNotice(null)
    try {
      const updated = await send()
      if (!current()) return
      onChanged(updated)
      if (attempt.action === "upload") clearChosen()
      else setConfirming(null)
    } catch (error) {
      if (!current()) return
      if (settled(error)) {
        // an attempt before this one landed after all: show the thread as it
        // is, and say what holds (an upload may have been removed since);
        // until it can be read, hold the controls
        if (attempt.action === "remove") setConfirming(null)
        const refresh: Unknown = attempt.action === "upload"
          ? { action: "landed", name: attempt.name, id: attempt.id }
          : { action: "refresh", done: `${attempt.attachment.name} was removed.` }
        if (!(await settle(refresh, current)) && current()) write.setUnresolved(refresh)
        return
      }
      const failed = failureOf(error, attempt.action === "upload" ? "Attaching the file failed." : "Removing the attachment failed.")
      if (!failed.unknown) return setFailure(failed)
      if (attempt.action === "remove") setConfirming(null)
      const unknown = { ...attempt, cause: failed.cause }
      if (!(await settle(unknown, current)) && current()) write.setUnresolved(unknown)
    }
  }

  function attach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!chosen) return
    const refused = refusal(chosen.file, limits)
    if (refused) return setFailure({ message: "Check the highlighted fields.", cause: refused.message, fields: { [refused.field]: refused.message }, unknown: false, viewerChanged: false })
    const { file, id } = chosen
    void write.start((current) => run(
      { action: "upload", name: file.name, id, cause: "" },
      () => uploadAttachment<Status>(repo, config.kind, thread.id, viewer, file, id),
      // its id is taken: this very upload landed before
      alreadyAttached,
      current,
    ))
  }

  function remove(attachment: ThreadAttachment) {
    void write.start((current) => run(
      { action: "remove", attachment, cause: "" },
      () => removeAttachment<Status>(repo, config.kind, thread.id, viewer, attachment.id),
      // gone already: what was asked, which the read shows
      (error) => error instanceof ApiError && error.code === "not_found",
      current,
    ))
  }

  const check = () => write.check(async (unknown, current) => {
    if (await settle(unknown, current)) write.setUnresolved(null)
  })

  // a refusal of the file itself, beside the file input
  const fileError = failure?.fields.file ?? failure?.fields.name
  const message = failure && (fileError ? null : failure)
  const editable = canAttach || thread.attachments.some((attachment) => attachment.actions.remove.available)
  const messages = (message || notice || write.unresolved) && (
    <div className="mt-3 max-w-md space-y-3">
      {message && <FailureMessage failure={message} />}
      {notice && <FormMessage kind={notice.kind}>{notice.text}</FormMessage>}
      {write.unresolved && <Unresolved pending={write.busy} onCheck={() => void check()} message={unresolvedMessage(write.unresolved)} />}
    </div>
  )

  return (
    <ThreadPanel id="thread-attachments" title="Attachments" frame={frame} edit={editable ? "Edit attachments" : undefined}
      compact={<><AttachmentList repo={repo} kind={config.kind} thread={thread.id} attachments={thread.attachments} noun={noun} />{messages}</>}>
      {thread.attachments.length === 0
        ? <p className="text-sm text-muted-foreground">Nothing is attached to this {noun}.</p>
        : (
          <ul aria-label="Attached files" className="divide-y rounded-xl border bg-card">
            {thread.attachments.map((attachment) => (
              <li key={attachment.id} className="px-4 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <AttachmentIcon attachment={attachment} />
                  <AttachmentLink href={attachmentUrl(repo, config.kind, thread.id, attachment.id)} attachment={attachment} />
                  <span className="shrink-0 text-xs text-muted-foreground">{attachment.inline ? "opens in a new tab" : "downloads"}</span>
                  {attachment.actions.remove.available && confirming !== attachment.id && (
                    <button type="button" aria-label={`Remove ${attachment.name}`} title={`Remove ${attachment.name}`} disabled={write.blocked}
                      className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                      onClick={(event) => { if (repeated(event)) return; setFailure(null); setNotice(null); setConfirming(attachment.id) }}>
                      <X size={14} aria-hidden />
                    </button>
                  )}
                </div>
                {confirming === attachment.id && (
                  <div role="alertdialog" aria-label={`Remove ${attachment.name}?`} aria-describedby={`remove-${attachment.id}`} className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                    <p id={`remove-${attachment.id}`}>Remove “{attachment.name}”? It disappears from this {noun} for everyone.</p>
                    <div className="mt-2 flex gap-2">
                      <Button type="button" variant="destructive" size="sm" disabled={write.blocked} onClick={(event) => { if (!repeated(event)) remove(attachment) }}>
                        {write.busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Remove attachment
                      </Button>
                      <Button type="button" variant="outline" size="sm" autoFocus disabled={write.busy} onClick={() => setConfirming(null)}>Cancel</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {messages}
      {canAttach && (
        <form aria-label="Attach a file" className="mt-3 max-w-md space-y-2" onSubmit={attach} noValidate>
          <fieldset disabled={write.blocked} className="disabled:opacity-60">
            <label htmlFor="attachment-file" className="text-sm font-medium">Attach a file</label>
            <input ref={fileInput} id="attachment-file" type="file" name="file"
              className="mt-1.5 block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              aria-invalid={fileError ? true : undefined} aria-describedby={fileError ? "attachment-file-hint attachment-file-error" : "attachment-file-hint"}
              onChange={(event) => choose(event.target.files?.[0] ?? null)} />
            <p id="attachment-file-hint" className="mt-1 text-xs text-muted-foreground">Up to {formatBytes(limits.max_bytes)}. Images open in the browser; other files download.</p>
            {/* announced, since focus stays on the button that submitted the file */}
            {fileError && <p id="attachment-file-error" role="alert" className="mt-1 text-xs text-destructive">{fileError}</p>}
          </fieldset>
          {/* the later clicks of a double click are ignored, even once the first one's answer has cleared the form */}
          <Button type="submit" variant="outline" size="sm" disabled={write.blocked || chosen === null} onClick={(event) => { if (repeated(event)) event.preventDefault() }}>
            {write.busy && confirming === null ? <LoaderCircle className="animate-spin" /> : <Paperclip />}Attach file
          </Button>
        </form>
      )}
    </ThreadPanel>
  )
}
