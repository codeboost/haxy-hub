import type { ThreadConfig } from "@/components/thread/config"
import { getBranchChoices, patchStatuses, type PatchStatus } from "@/lib/patches"
import { StartForkLink } from "./drafts/StartForkLink"

/**
 * Patches for the shared thread components: their lists, labels, comments,
 * and the forms that open a branch-backed patch and edit one (choosing its
 * branches, or starting it with a new fork instead), and close, reopen or
 * remove it.
 */
export const patchThreads: ThreadConfig<PatchStatus> = {
  kind: "patches",
  noun: "Patch",
  plural: "Patches",
  statuses: patchStatuses,
  statusLabels: { open: "Open", closed: "Closed", merged: "Merged" },
  // a merged patch stays merged
  statusChanges: { open: { to: "closed", label: "Close patch" }, closed: { to: "open", label: "Reopen patch" } },
  branches: { load: getBranchChoices },
  conflicts: true,
  newAlternative: StartForkLink,
}
