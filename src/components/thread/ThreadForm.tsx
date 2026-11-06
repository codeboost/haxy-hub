import { useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, TextField, type Failure } from "@/components/form"
import type { ThreadFields } from "@/lib/threads"
import { BranchFields, branchLabels, type BranchOffer } from "./BranchFields"
import type { ThreadConfig } from "./config"

const textareaClass =
  "mt-1.5 block min-h-48 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"

/**
 * A thread's fields (title, labels, description, and a patch's branches when
 * `branches` offers them), as Haxy's own new and edit forms have them. Every field is kept on failure (none is secret), and
 * `pending` holds the form: a second submission is ignored until the first
 * settles, so one click can't write twice. `blocked` holds it too, e.g. until
 * an unknown outcome is settled.
 */
export function ThreadForm<Status extends string>({ config, label, initial, branches, submitLabel, icon, pending, blocked = false, failure, notice, onSubmit }: {
  config: ThreadConfig<Status>
  /** The branches a patch's form chooses among; its `initial` names the chosen ones. */
  branches?: BranchOffer
  /** The form's accessible name. */
  label: string
  initial: ThreadFields
  submitLabel: string
  icon: ReactNode
  pending: boolean
  blocked?: boolean
  failure: Failure | null
  /** What to show above the fields besides a failure (an unknown outcome, a conflict). */
  notice?: ReactNode
  onSubmit(fields: ThreadFields): void
}) {
  const [title, setTitle] = useState(initial.title)
  const [labels, setLabels] = useState(initial.labels)
  const [description, setDescription] = useState(initial.description)
  const [source, setSource] = useState(initial.source ?? "")
  const [target, setTarget] = useState(initial.target ?? "")
  const descriptionId = useId()
  // React state updates after the first click, so a double click would
  // otherwise submit twice before `pending` arrives.
  const submitting = useRef(false)
  if (!pending) submitting.current = false

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || blocked || submitting.current) return
    submitting.current = true
    onSubmit(branches ? { title, labels, description, ...(branches.source ? { source } : {}), target } : { title, labels, description })
  }

  const fields = failure?.fields ?? {}
  // a refusal of a field the form doesn't show (a patch's source, when editing) is said above the fields
  const shownFields = ["title", "labels", "description", ...(branches ? [...(branches.source ? ["source"] : []), "target"] : [])]
  const noun = config.noun.toLowerCase()
  return (
    <form aria-label={label} className="mt-6 max-w-3xl space-y-5" onSubmit={submit} noValidate>
      {failure && <FailureMessage failure={failure} shown={shownFields} labels={branchLabels} />}
      {notice}
      <TextField label="Title" name="title" value={title} onValue={setTitle} error={fields.title} autoComplete="off" required />
      <TextField label="Labels" name="labels" value={labels} onValue={setLabels} error={fields.labels} autoComplete="off" autoCapitalize="none" spellCheck={false}
        hint="Separate labels with spaces." />
      <div>
        <label htmlFor={descriptionId} className="text-sm font-medium">Description</label>
        <textarea id={descriptionId} name="description" className={textareaClass} value={description} onChange={(event) => setDescription(event.target.value)}
          aria-invalid={fields.description ? true : undefined} aria-describedby={`${descriptionId}-hint`} />
        <p id={`${descriptionId}-hint`} className="mt-1 text-xs text-muted-foreground">Markdown, as Haxy renders it on the {noun}'s page.</p>
        {fields.description && <p className="mt-1 text-xs text-destructive">{fields.description}</p>}
      </div>
      {branches && <BranchFields offer={branches} source={source} target={target} onSource={setSource} onTarget={setTarget} errors={fields} />}
      {/* the later clicks of a double click don't submit again, even once the first has settled */}
      <Button type="submit" disabled={pending || blocked} onClick={(event) => { if (event.detail > 1) event.preventDefault() }}>
        {pending ? <LoaderCircle className="animate-spin" /> : icon}
        {submitLabel}
      </Button>
    </form>
  )
}
