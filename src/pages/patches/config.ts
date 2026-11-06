import type { ThreadConfig } from "@/components/thread/config"
import { patchStatuses, type PatchStatus } from "@/lib/patches"

/** Patches for the shared thread components: their lists, labels and comments. */
export const patchThreads: ThreadConfig<PatchStatus> = {
  kind: "patches",
  noun: "Patch",
  plural: "Patches",
  statuses: patchStatuses,
  statusLabels: { open: "Open", closed: "Closed", merged: "Merged" },
  // changing a patch's status isn't in Haxy Hub yet
  statusChanges: {},
}
