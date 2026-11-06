import { useId, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { TextField } from "@/components/form"
import { AuthorName } from "@/components/thread/ThreadParts"
import type { ConflictChunk, ConflictField, ConflictSide, ConflictValue, MetadataConflict } from "@/lib/conflicts"
import type { ThreadAuthor } from "@/lib/threads"

const fieldLabels: Record<string, string> = { title: "Title", labels: "Labels", status: "Status", revision: "Revision", target: "Target branch" }
const sideNames = { ours: "Current", theirs: "Merged in" } as const
const shortCommit = 12
const chunkRows = 4

function label(name: string): string {
  return fieldLabels[name] ?? name
}

/** Who set a side's value, or that it isn't known. */
function Byline({ author }: { author: ThreadAuthor }) {
  return <span className="text-xs text-muted-foreground">edited by <AuthorName author={author} /></span>
}

function valueText(value: ConflictValue): string {
  if (value === null) return "None"
  if (typeof value === "string") return value
  if ("source_commit" in value) return `${value.source_commit.slice(0, shortCommit)} (squashed ${value.squash_commit.slice(0, shortCommit)})`
  return value.name
}

/** One side of a field: its value, who wrote it, and a way to use it. */
function SideCard({ side, which, children }: { side: ConflictSide; which: keyof typeof sideNames; children?: ReactNode }) {
  return (
    <div role="group" aria-label={sideNames[which]} className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{sideNames[which]} <Byline author={side.author} /></span>
        {children}
      </div>
      <pre className="mt-2 font-mono text-sm whitespace-pre-wrap">{valueText(side.value) || "(empty)"}</pre>
    </div>
  )
}

/** A conflicted title or labels: both sides, and the text that resolves it. */
export function TextFieldConflict({ field, value, onValue, error, disabled }: { field: ConflictField; value: string; onValue(value: string): void; error?: string; disabled: boolean }) {
  const use = (side: ConflictSide) => <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onValue(valueText(side.value))}>Use this</Button>
  return (
    <fieldset className="space-y-3">
      <legend className="font-semibold">{label(field.name)}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SideCard side={field.ours} which="ours">{use(field.ours)}</SideCard>
        <SideCard side={field.theirs} which="theirs">{use(field.theirs)}</SideCard>
      </div>
      <TextField label={`Resolved ${label(field.name).toLowerCase()}`} name={field.name} value={value} onValue={onValue} error={error} disabled={disabled} />
    </fieldset>
  )
}

/** A conflicted status, revision or target, which takes one side whole. */
export function ChoiceFieldConflict({ field, side, onSide, disabled }: { field: ConflictField; side: "ours" | "theirs"; onSide(side: "ours" | "theirs"): void; disabled: boolean }) {
  const name = useId()
  const option = (which: "ours" | "theirs") => (
    <label className="flex items-start gap-2 rounded-lg border bg-card p-3">
      <input type="radio" name={name} className="mt-1" checked={side === which} disabled={disabled} onChange={() => onSide(which)} aria-label={`${sideNames[which]} ${label(field.name).toLowerCase()}`} />
      <span>
        <span className="text-sm font-medium">{sideNames[which]} <Byline author={field[which].author} /></span>
        <span className="mt-1 block font-mono text-sm">{valueText(field[which].value)}</span>
      </span>
    </label>
  )
  return (
    <fieldset className="space-y-3">
      <legend className="font-semibold">{label(field.name)}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{option("ours")}{option("theirs")}</div>
    </fieldset>
  )
}

type Description = NonNullable<MetadataConflict["description"]>

/** The description, chunk by chunk: what both sides agree on, what one side alone changed, and each conflicting part with the text that resolves it. */
export function DescriptionConflict({ description, hunks, onHunks, error, disabled }: { description: Description; hunks: string[]; onHunks(hunks: string[]): void; error?: string; disabled: boolean }) {
  let next = 0
  return (
    <fieldset className="space-y-3">
      <legend className="font-semibold">Description</legend>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {description.chunks.map((chunk, index) => {
        if (chunk.kind !== "conflict") return <SettledChunk key={index} chunk={chunk} description={description} />
        const part = next++
        return <ConflictingChunk key={index} part={part} chunk={chunk} description={description} value={hunks[part] ?? ""} disabled={disabled}
          onValue={(value) => onHunks(hunks.map((hunk, at) => (at === part ? value : hunk)))} />
      })}
    </fieldset>
  )
}

function SettledChunk({ chunk, description }: { chunk: Exclude<ConflictChunk, { kind: "conflict" }>; description: Description }) {
  if (chunk.kind === "same") return <pre className="rounded-md bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap">{chunk.text}</pre>
  const author = chunk.side === "ours" ? description.ours_author : description.theirs_author
  return (
    <div className="rounded-md border border-dashed px-3 py-2">
      <p className="text-xs text-muted-foreground">Changed only on the {sideNames[chunk.side].toLowerCase()} side, so it stands: <Byline author={author} /></p>
      <pre className="mt-1 font-mono text-sm whitespace-pre-wrap">{chunk.text ?? "(removed)"}</pre>
    </div>
  )
}

function ConflictingChunk({ part, chunk, description, value, onValue, disabled }: { part: number; chunk: Extract<ConflictChunk, { kind: "conflict" }>; description: Description; value: string; onValue(value: string): void; disabled: boolean }) {
  const id = useId()
  const side = (which: "ours" | "theirs", author: ThreadAuthor): ConflictSide => ({ value: chunk[which] ?? "", author })
  const use = (text: string | null) => <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onValue(text ?? "")}>Use this</Button>
  return (
    <div role="group" aria-label={`Conflicting part ${part + 1}`} className="space-y-3 rounded-lg border border-amber-500/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <SideCard side={side("ours", description.ours_author)} which="ours">{use(chunk.ours)}</SideCard>
        <SideCard side={side("theirs", description.theirs_author)} which="theirs">{use(chunk.theirs)}</SideCard>
      </div>
      <label htmlFor={id} className="text-sm font-medium">Resolved part {part + 1}</label>
      <textarea id={id} value={value} disabled={disabled} onChange={(event) => onValue(event.target.value)} rows={chunkRows}
        className="block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />
      <p className="text-xs text-muted-foreground">Leave it empty to drop this part.</p>
    </div>
  )
}
