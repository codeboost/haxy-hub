import { useId } from "react"
import type { BranchChoices } from "@/lib/patches"
import { displaySegment, type RefId, type RefItem, type RepoLocator } from "@/lib/repo"
import { useResource, type Resource } from "@/lib/resource"
import type { ThreadConfig } from "./config"

const selectClass =
  "mt-1.5 block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"

/**
 * The branches a kind's forms choose among (`config.branches`, patches), read
 * for `viewerKey`'s form; `null` for a kind whose forms choose none.
 */
export function useBranchChoices<Status extends string>(repo: RepoLocator, config: ThreadConfig<Status>, viewerKey: string): (Resource<BranchChoices> & { reload(): void }) | null {
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const { branches } = config
  const choices = useResource(`${config.kind} branches ${key} ${viewerKey} ${branches ? "" : "none"}`, (signal) =>
    branches ? branches.load(repo, { signal }) : Promise.resolve({ branches: [], truncated: false, defaultTarget: null }))
  return branches ? choices : null
}

/** How a patch's branch fields are named, for a refusal shown away from them. */
export const branchLabels: Record<string, string> = { source: "Source branch", target: "Target branch" }

/** What a form's branch fields offer: the branches, and whether it chooses a source too (only a new thread does). */
export type BranchOffer = { choices: BranchChoices; source: boolean }

/**
 * The source and target branch pickers of a patch's form, by Haxy's ref ids.
 * A value no listed branch has (one past the list's end, or one deleted
 * since) is offered as it is, so the form never changes it silently.
 */
export function BranchFields({ offer, source, target, onSource, onTarget, errors }: {
  offer: BranchOffer
  source: RefId
  target: RefId
  onSource(value: RefId): void
  onTarget(value: RefId): void
  errors: { source?: string; target?: string }
}) {
  const more = offer.choices.truncated ? ` Only the first ${offer.choices.branches.length} branches are listed.` : ""
  return (
    <>
      {offer.source && (
        <BranchSelect label="Source branch" name="source" value={source} onValue={onSource} branches={offer.choices.branches} error={errors.source}
          hint={`The branch whose commits the patch proposes; pushes to it update the patch.${more}`} />
      )}
      <BranchSelect label="Target branch" name="target" value={target} onValue={onTarget} branches={offer.choices.branches} error={errors.target}
        hint={`The branch the patch would be merged into.${more}`} />
    </>
  )
}

function BranchSelect({ label, name, value, onValue, branches, error, hint }: {
  label: string
  name: string
  value: RefId
  onValue(value: RefId): void
  branches: RefItem[]
  error?: string
  hint: string
}) {
  const id = useId()
  const listed = value === "" || branches.some((branch) => branch.id === value)
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <select id={id} name={name} className={selectClass} value={value} onChange={(event) => onValue(event.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}>
        {value === "" && <option value="" disabled>Choose a branch</option>}
        {!listed && <option value={value}>{displaySegment(value.replace(/^branch:/, ""))}</option>}
        {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
      </select>
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
