/**
 * A thread's attachments, through haxy's src/api/attachments.zig, which
 * shares its rules with the TUI and Haxy's own upload route
 * (src/attachment.zig, `thread_write.attach`/`remove`): the size and name
 * limits, which files open in the browser, and who may attach or remove are
 * Haxy's. A thread's answer lists its attachments and the limits; Hub checks
 * a file against them before sending it, and Haxy checks again.
 *
 * Bytes never pass through page state: an upload sends the File itself as
 * the request body, and a download is a plain link to Haxy's route, which
 * names the file and decides whether the browser shows or saves it.
 */
import { ApiError, requestJson, type ActionAvailability, type EventId } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { threadApiPath, type ThreadDetail, type ThreadKind, type WriteViewer } from "@/lib/threads"

/** One attachment, as a thread's answer lists it. */
export type ThreadAttachment = {
  id: EventId
  /** For display (bytes that aren't UTF-8 are replaced). */
  name: string
  content_type: string
  /** Whether the browser shows it in place (safe images) rather than saving it. */
  inline: boolean
  actions: { remove: ActionAvailability }
}

/** What Haxy accepts in an upload. */
export type AttachmentLimits = { max_bytes: number; max_name_bytes: number }

function attachmentsPath(repo: RepoLocator, kind: ThreadKind, thread: EventId): string {
  return `${threadApiPath(repo, kind, thread)}/attachments`
}

/** Where an attachment's bytes are served: a link to it opens or downloads it. */
export function attachmentUrl(repo: RepoLocator, kind: ThreadKind, thread: EventId, id: EventId): string {
  return `${attachmentsPath(repo, kind, thread)}/${encodeURIComponent(id)}`
}

/** "2.5 MB", "812 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`
}

/**
 * Why Haxy would refuse `file`, by the limits it published, keyed as its
 * field errors are (`file`, `name`); null when it fits. Haxy's own check is
 * the authority: this only spares sending a file it would refuse.
 */
export function refusal(file: File, limits: AttachmentLimits): { field: "file" | "name"; message: string } | null {
  if (file.size === 0) return { field: "file", message: "The file is empty." }
  if (file.size > limits.max_bytes) {
    // just past the limit rounds to it, so say exactly how far past
    const size = formatBytes(file.size) === formatBytes(limits.max_bytes) ? `${file.size.toLocaleString("en-US")} bytes` : formatBytes(file.size)
    return { field: "file", message: `Files can be up to ${formatBytes(limits.max_bytes)}; this one is ${size}.` }
  }
  if (new TextEncoder().encode(file.name).length > limits.max_name_bytes) return { field: "name", message: `A file name can be up to ${limits.max_name_bytes} bytes.` }
  return null
}

/**
 * Uploads `file` under `id` (a fresh id per file, from `newThreadId`), and
 * resolves to the thread with it. The id makes the upload idempotent: Haxy
 * refuses a second attachment under it (`conflict` keyed by `id`, see
 * `alreadyAttached`), so an upload whose outcome is unknown can be looked up
 * in the thread and sent again safely. No client timeout applies.
 */
export function uploadAttachment<Status extends string>(repo: RepoLocator, kind: ThreadKind, thread: EventId, viewer: WriteViewer, file: File, id: EventId): Promise<ThreadDetail<Status>> {
  const query = `name=${encodeURIComponent(file.name)}&id=${encodeURIComponent(id)}`
  return requestJson(`${attachmentsPath(repo, kind, thread)}?${query}`, {
    method: "POST",
    viewer,
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  })
}

/** Removes the attachment; `not_found` when it is gone already (or never was). Resolves to the thread without it. */
export function removeAttachment<Status extends string>(repo: RepoLocator, kind: ThreadKind, thread: EventId, viewer: WriteViewer, id: EventId): Promise<ThreadDetail<Status>> {
  return requestJson(attachmentUrl(repo, kind, thread, id), { method: "DELETE", viewer })
}

/** Whether Haxy refused an upload because an event already has its id: an earlier attempt landed. */
export function alreadyAttached(error: unknown): boolean {
  return error instanceof ApiError && error.code === "conflict" && "id" in error.fieldErrors
}
