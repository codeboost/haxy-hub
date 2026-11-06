/**
 * Merging a patch through haxy's src/api/patch_merge.zig: with its source
 * commits or its squashed commit, sending what the page showed (the patch's
 * revision and the target branch's tip). Haxy checks both again when the
 * merge runs and refuses a merge of anything else; a merge has no client
 * timeout, and one whose answer is lost is never retried by itself.
 */
import { requestJson, type EventId, type ObjectId } from "@/lib/api"
import type { MergeResult, PatchDetail } from "@/lib/patches"
import { apiBase, type RepoLocator } from "@/lib/repo"
import type { WriteViewer } from "@/lib/threads"

export type MergeMethod = "source" | "squash"

export const mergeMethods = ["source", "squash"] as const satisfies readonly MergeMethod[]

/** What a merge sends back: what the page showed when it was asked for. */
export type Reviewed = { revision: EventId; target_commit: ObjectId }

/** A way of merging as the page offers it: whether it may run now, and why not. */
export type MergeChoice = { method: MergeMethod; enabled: boolean; note: string | null }

const notes: Record<Exclude<MergeResult, "clean">, string> = {
  conflict: "Conflicts with the target branch.",
  unknown: "Not checked against the target branch yet.",
}

/** What the page shows of `patch`, for a merge to be checked against; null when there is nothing to merge. */
export function reviewedOf(patch: PatchDetail): Reviewed | null {
  if (!patch.revision || !patch.target.commit) return null
  return { revision: patch.revision.id, target_commit: patch.target.commit }
}

/** Each way of merging `patch`: offered while Haxy says the viewer may merge it and that way merges cleanly. */
export function mergeChoices(patch: PatchDetail): MergeChoice[] {
  const offered = patch.actions.merge.available && patch.mergeability.available && reviewedOf(patch) !== null
  return mergeMethods.map((method) => {
    const result = patch.mergeability.available ? patch.mergeability[method] : "unknown"
    return { method, enabled: offered && result === "clean", note: result === "clean" ? null : notes[result] }
  })
}

/** Merges the patch as `reviewed` showed it; resolves to the merged patch. */
export function mergePatch(repo: RepoLocator, id: EventId, viewer: WriteViewer, method: MergeMethod, reviewed: Reviewed): Promise<PatchDetail> {
  return requestJson<PatchDetail>(`${apiBase(repo)}/patches/${encodeURIComponent(id)}/merge`, {
    method: "POST",
    viewer,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, ...reviewed }),
  })
}
