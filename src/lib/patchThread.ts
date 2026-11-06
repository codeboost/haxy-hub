/**
 * A patch as the shared thread pieces read a thread (`ThreadNew`,
 * `ThreadEdit`, `ThreadActions`): its own answer, with the revision an edit
 * replaces as `revision` (a patch's own `revision` is the patch revision it
 * proposes, so Haxy sends the edit's as `edit_revision`), no assignees, and
 * the whole answer kept as `patch` for the patch page. `@/lib/threads` reads
 * every patch answer through `asPatchThread`.
 */
import type { ActionAvailability } from "@/lib/api"
import type { PatchDetail, PatchStatus } from "@/lib/patches"
import type { ThreadDetail } from "@/lib/threads"

export type PatchAnswer = PatchDetail

export type PatchThread = ThreadDetail<PatchStatus> & { patch: PatchDetail }

const noAssignees: ActionAvailability = { available: false, reason: { code: "unsupported", message: "Patches have no assignees." } }

export function asPatchThread(patch: PatchDetail): PatchThread {
  return { ...patch, revision: patch.edit_revision, assignees: [], actions: { ...patch.actions, assign: noAssignees }, patch }
}

/** The patch a shared thread piece's answer (or read) holds. */
export function patchOf(thread: ThreadDetail<PatchStatus>): PatchDetail {
  const { patch } = thread as Partial<PatchThread>
  if (!patch) throw new Error("This answer isn't a patch's.")
  return patch
}
