import { useState, type FormEvent, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { Check, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { linkClass } from "@/components/thread/config"
import type { ActionAvailability } from "@/lib/api"
import { conflictChanged, getConflict, initialChoices, resolutionOf, resolveConflict, type Choices, type ConflictKind, type MetadataConflict } from "@/lib/conflicts"
import type { RepoLocator } from "@/lib/repo"
import { threadRoute, type WriteViewer } from "@/lib/threads"
import { useLatest } from "@/pages/settings/shared"
import { ChoiceFieldConflict, DescriptionConflict, TextFieldConflict } from "./ConflictFields"

/**
 * What stands in the way of resolving: an outcome Haxy couldn't confirm,
 * being settled by reading the conflict again, or a conflict that changed
 * (or was resolved) since the form loaded, which the user must load again.
 */
type Notice =
  | { kind: "checking"; cause: string }
  | { kind: "unchecked"; cause: string }
  | { kind: "unsaved"; cause: string }
  | { kind: "settled"; cause: string }
  | { kind: "stale" }

type Props = { repo: RepoLocator; kind: ConflictKind; noun: string; id: string; conflict: MetadataConflict; resolve: ActionAvailability; viewer: WriteViewer; reload(): void }

type Target = Pick<Props, "repo" | "kind" | "id" | "conflict" | "viewer">

/**
 * One resolution's write: `pending` while it runs, a refusal as `failure`,
 * and an outcome Haxy couldn't confirm settled by reading the conflict again.
 */
function useResolve({ repo, kind, id, conflict, viewer }: Target) {
  const navigate = useNavigate()
  const latest = useLatest()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const blocked = pending || (notice !== null && notice.kind !== "unsaved")

  // an unknown outcome: the conflict still at the revision it was made against
  // means nothing was recorded; gone or changed means it was settled, perhaps by it
  async function settle(cause: string) {
    const started = latest.begin()
    setNotice({ kind: "checking", cause })
    try {
      const current = await getConflict(repo, kind, id)
      if (latest.isLatest(started)) setNotice({ kind: current.conflict?.revision === conflict.revision ? "unsaved" : "settled", cause })
    } catch {
      if (latest.isLatest(started)) setNotice({ kind: "unchecked", cause })
    }
  }

  async function submit(choices: Choices) {
    if (blocked) return
    const started = latest.begin()
    setPending(true)
    setFailure(null)
    setNotice(null)
    try {
      await resolveConflict(repo, kind, id, viewer, conflict.revision, resolutionOf(conflict, choices))
      if (latest.isLatest(started)) await navigate(threadRoute(repo, kind, id))
    } catch (error) {
      if (!latest.isLatest(started)) return
      setPending(false)
      if (conflictChanged(error)) return setNotice({ kind: "stale" })
      const failed = failureOf(error, "Resolving the conflict failed.")
      if (failed.unknown) await settle(failed.cause)
      else setFailure(failed)
    }
  }

  return { pending, failure, notice, blocked, settle, submit }
}

export function ResolveForm({ repo, kind, noun, id, conflict, resolve, viewer, reload }: Props) {
  const [choices, setChoices] = useState<Choices>(() => initialChoices(conflict))
  const write = useResolve({ repo, kind, id, conflict, viewer })
  const { failure, notice } = write
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void write.submit(choices)
  }
  if (!resolve.available) return <><ConflictSides conflict={conflict} choices={choices} onChange={setChoices} disabled errors={{}} /><p role="status" className="mt-6 text-sm text-muted-foreground">{resolve.reason.message}</p></>
  return (
    <form aria-label={`Resolve the ${noun}'s conflict`} onSubmit={onSubmit} className="mt-6 space-y-8">
      <ConflictSides conflict={conflict} choices={choices} onChange={setChoices} disabled={write.blocked} errors={failure?.fields ?? {}} />
      {failure && <FailureMessage failure={failure} shown={["title", "labels", "description"]} labels={{ theirs: "Their side", revision: "Revision", source: "Source branch", target: "Target branch" }} />}
      {notice && <NoticeMessage notice={notice} noun={noun} thread={threadRoute(repo, kind, id)} onCheck={() => void write.settle(notice.kind === "stale" ? "" : notice.cause)} onReload={reload} />}
      <Button type="submit" disabled={write.blocked}><Check />{write.pending ? "Resolving…" : "Resolve conflict"}</Button>
    </form>
  )
}

function ConflictSides({ conflict, choices, onChange, disabled, errors }: { conflict: MetadataConflict; choices: Choices; onChange(value: Choices): void; disabled: boolean; errors: Record<string, string> }) {
  return (
    <div className="space-y-8">
      {conflict.fields.map((field) => field.resolution === "text"
        ? <TextFieldConflict key={field.name} field={field} value={choices.texts[field.name] ?? ""} error={errors[field.name]} disabled={disabled}
            onValue={(value) => onChange({ ...choices, texts: { ...choices.texts, [field.name]: value } })} />
        : <ChoiceFieldConflict key={field.name} field={field} side={choices.sides[field.name] ?? "ours"} disabled={disabled}
            onSide={(side) => onChange({ ...choices, sides: { ...choices.sides, [field.name]: side } })} />)}
      {conflict.description && <DescriptionConflict description={conflict.description} hunks={choices.hunks} error={errors.description} disabled={disabled}
        onHunks={(hunks) => onChange({ ...choices, hunks })} />}
    </div>
  )
}

function NoticeMessage({ notice, noun, thread, onCheck, onReload }: { notice: Notice; noun: string; thread: string; onCheck(): void; onReload(): void }) {
  const reloadButton = (label: string, onClick: () => void): ReactNode => <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onClick}><RefreshCw />{label}</Button>
  switch (notice.kind) {
    case "checking":
      return <FormMessage kind="error">Haxy couldn't confirm what happened to this request ({notice.cause}). Checking the conflict…</FormMessage>
    case "unchecked":
      return <FormMessage kind="error"><p>Haxy couldn't confirm what happened to this request ({notice.cause}), nor say whether the conflict changed.</p>{reloadButton("Check the conflict", onCheck)}</FormMessage>
    case "unsaved":
      return <FormMessage kind="error">Haxy couldn't confirm what happened to this request ({notice.cause}). The conflict is unchanged, so nothing was recorded; resolve again to try once more.</FormMessage>
    case "settled":
      return <FormMessage kind="error"><p>Haxy couldn't confirm what happened to this request ({notice.cause}). The conflict isn't as you loaded it any more: it was resolved, perhaps by this request, or changed. <Link to={thread} className={linkClass}>See the {noun}</Link>.</p>{reloadButton("Load the conflict again", onReload)}</FormMessage>
    case "stale":
      return <FormMessage kind="error"><p>This conflict changed since you loaded it: someone resolved it, edited the {noun}, or synced new edits. Your choices weren't recorded.</p>{reloadButton("Load the current conflict", onReload)}</FormMessage>
  }
}
