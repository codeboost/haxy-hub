import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { LoaderCircle, Undo2 } from "lucide-react"
import { useSession } from "@/app/session"
import { Button } from "@/components/ui/button"
import { FailureMessage, failureOf, type Failure } from "@/components/form"
import { EmptyState, FailureState, Pager, useListParams } from "@/components/listing"
import { linkClass } from "@/components/thread/config"
import { Instant, SectionUnavailable } from "@/components/thread/ThreadParts"
import { ApiError } from "@/lib/api"
import type { TransactionId } from "@/lib/events"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { listUndo, undoPage, undoRoute, undoTargetRoute, undoTransaction, type UndoHistory, type UndoRecord, type UndoResult, type UndoRevision } from "@/lib/undo"
import { lostAccess, useWrite } from "@/pages/settings/shared"
import { Unresolved } from "@/pages/settings/Unresolved"

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

/**
 * A repository's undo history: `<repo>/undo`, or from one transaction,
 * `<repo>/undo/<id>`, each with `?cursor=`. The history is always requested,
 * since the viewer's role may have changed since the repository's sections
 * were read; Haxy answers with its reason (not found for viewers who may not
 * see it, unsupported in local mode).
 */
export function UndoSection({ repo, tail }: { repo: RepoLocator; tail: string }) {
  const { viewer } = useSession()
  const { cursor } = useListParams()
  const page = undoPage(tail)
  if (page.kind === "unknown") {
    return (
      <section className="mt-6">
        <h2 className="text-2xl font-semibold tracking-tight">Page not found</h2>
        <Link to={undoRoute(repo)} className={`mt-4 inline-block text-sm ${linkClass}`}>Undo history</Link>
      </section>
    )
  }
  // an undo is bound to the viewer the history was loaded for
  return <History key={`${viewer?.name ?? ""} ${page.transaction ?? ""}`} repo={repo} viewer={viewer?.name ?? null} transaction={page.transaction} cursor={cursor} />
}

/**
 * What an undo the viewer chose is about to do: undo `record`, as of the
 * history at `revision`, whose newest transaction is `newest`.
 */
type Choice = { record: UndoRecord; revision: UndoRevision; newest: TransactionId; reversal: boolean }

/** Said after an undo was refused or its outcome was unknown, once the history was read again. */
type Notice = { kind: "error" | "info"; text: string }

function History({ repo, viewer, transaction, cursor }: { repo: RepoLocator; viewer: string | null; transaction?: TransactionId; cursor: string }) {
  const location = useLocation()
  // an undo reads the history again in the background, keeping what the page says
  const [version, setVersion] = useState(0)
  const history = useResource(`undo ${repoKey(repo)} ${transaction ?? ""} ${cursor}`, (signal) => listUndo(repo, { transaction, cursor }, { signal }), `${location.key} ${version}`)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [result, setResult] = useState<UndoResult | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  // an undo whose outcome is unknown and that a read couldn't settle: no
  // undo is offered until a check gets an answer
  const write = useWrite<string>()

  /**
   * What the history says now, after an undo whose outcome is unknown: the
   * newest transaction, which an undo from now on names. Nothing that names
   * the history as it was can land twice: Haxy refuses an undo once the
   * history has moved on.
   */
  async function settle(cause: string, current: () => boolean): Promise<void> {
    let now: UndoHistory
    try {
      now = await listUndo(repo)
    } catch (error) {
      if (!current()) return
      if (lostAccess(error)) {
        write.setUnresolved(null)
        setNotice({ kind: "error", text: `${cause} Haxy couldn't confirm the undo, and you can no longer see this repository's undo history.` })
        setVersion((value) => value + 1)
      } else {
        write.setUnresolved(cause)
      }
      return
    }
    if (!current()) return
    write.setUnresolved(null)
    const newest = now.items[0]
    const said = newest ? `The newest transaction is now ${newest.transaction} (${newest.action}), which may or may not be from this attempt.` : ""
    setNotice({ kind: "info", text: `${cause} Haxy couldn't confirm the undo. ${said} The history below is as it is now; review it before undoing again.` })
    setVersion((value) => value + 1)
  }

  const execute = (chosen: Choice) => write.start(async (current) => {
    if (viewer === null) return
    setFailure(null)
    setNotice(null)
    try {
      const done = await undoTransaction(repo, viewer, chosen.record.transaction, chosen.revision)
      if (!current()) return
      setChoice(null)
      setResult(done)
      setVersion((value) => value + 1)
    } catch (error) {
      if (!current()) return
      const failed = failureOf(error, "Undoing failed.")
      // someone else is signed in now (or nobody): only a reload helps, and
      // the history isn't read again as them
      if (failed.viewerChanged) return setFailure(failed)
      if (failed.unknown) {
        setChoice(null)
        setResult(null)
        return settle(failed.cause, current)
      }
      if (error instanceof ApiError && error.code === "conflict") {
        // the history moved on since it was read: show it as it is now
        setChoice(null)
        setResult(null)
        setNotice({ kind: "info", text: `${error.fieldErrors.revision ?? error.message} It's shown below as it is now.` })
        setVersion((value) => value + 1)
        return
      }
      if (!failed.viewerChanged && lostAccess(error)) {
        // no longer an owner (or no longer able to see the history): say so,
        // stop offering a reversal Haxy now refuses, and read what the viewer may do now
        setChoice(null)
        setNotice({ kind: "error", text: failed.message })
        setResult((shown) => shown && { ...shown, record: { ...shown.record, actions: { undo: { available: false, reason: { code: "forbidden", message: failed.message } } } } })
        setVersion((value) => value + 1)
        return
      }
      setFailure(failed)
    }
  })

  const check = () => write.check((cause, current) => settle(cause, current))

  // what an undo did, or why it didn't, shows whatever reading the history again brings
  const outcome = (
    <>
      {result && <UndoResultPanel repo={repo} result={result} disabled={write.blocked || viewer === null} onReverse={() => { setFailure(null); setChoice({ record: result.record, revision: result.revision, newest: result.record.transaction, reversal: true }) }} />}
      {notice && (notice.kind === "error"
        ? <div role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{notice.text}</div>
        : <p role="status" className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">{notice.text}</p>)}
      {write.unresolved !== null && (
        <div className="mt-4">
          <Unresolved message={`${write.unresolved} Haxy couldn't confirm the undo, or say what the history holds now, so no undo is offered until a check gets an answer.`} pending={write.busy} onCheck={() => void check()} />
        </div>
      )}
      {choice && <Confirmation choice={choice} failure={failure} busy={write.busy} onConfirm={() => void execute(choice)} onCancel={() => { setChoice(null); setFailure(null) }} />}
    </>
  )
  const written = result !== null || notice !== null || write.unresolved !== null || choice !== null

  let list: ReactNode
  if (history.kind === "failed") {
    // unsupported (local mode) or not found (may not see it): Haxy says why
    if (history.error.code === "unsupported" || history.error.code === "not_found") {
      if (!written) return <SectionUnavailable>{history.error.message}</SectionUnavailable>
      list = <SectionUnavailable>{history.error.message}</SectionUnavailable>
    } else if (history.error.code === "validation" && cursor) {
      // a page link outlived its list
      list = <EmptyState title="This page is no longer available"><Link to={undoRoute(repo)} className={linkClass}>Back to the newest transactions</Link></EmptyState>
    } else {
      list = <FailureState title="Couldn't load the undo history" error={history.error} onRetry={history.reload} />
    }
  } else {
    const data = history.data
    const forbidden = data.items.map((item) => item.actions.undo).find((action) => !action.available && action.reason.code === "forbidden")
    const busy = write.blocked || viewer === null
    list = (
      <>
        {forbidden && !forbidden.available && <p role="status" className="mt-3 text-sm text-muted-foreground">{forbidden.reason.message}</p>}
        {data.items.length === 0 ? (
          <EmptyState title="No transactions" />
        ) : (
          <>
            <ul aria-label="Undo history" className="mt-4 divide-y rounded-xl border bg-card">
              {data.items.map((record) => (
                <li key={record.transaction} aria-label={`Transaction ${record.transaction}`} className="px-4 py-3">
                  <RecordSummary repo={repo} record={record} />
                  {record.actions.undo.available && (
                    <Button variant="outline" size="sm" className="mt-2" disabled={busy || choice !== null}
                      onClick={() => { setFailure(null); setChoice({ record, revision: data.revision, newest: data.newest, reversal: false }) }}>
                      <Undo2 />{record.transaction === data.newest ? "Undo this" : "Undo this and all after it"}
                    </Button>
                  )}
                  {!record.actions.undo.available && record.actions.undo.reason.code !== "forbidden" && (
                    <p className="mt-1 text-xs text-muted-foreground">{record.actions.undo.reason.message}</p>
                  )}
                </li>
              ))}
            </ul>
            <Pager page={data.page} search="" cursor={cursor} noun="Undo history" base={undoRoute(repo, { transaction })} />
          </>
        )}
      </>
    )
  }
  const first = history.kind === "loaded" ? history.data.items[0]?.transaction : undefined
  return (
    <section aria-labelledby="undo-heading" className="mt-6">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h2 id="undo-heading" className="text-2xl font-semibold tracking-tight">{transaction === undefined && !cursor ? "Undo history" : `Undo history from transaction ${first ?? transaction ?? ""}`.trim()}</h2>
        {(transaction !== undefined || cursor) && <Link to={undoRoute(repo)} className={`text-sm ${linkClass}`}>Newest transactions</Link>}
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Every change to this repository is a transaction. Undoing one returns the repository to its state before it, discarding it and every transaction after it.
        The undo is a transaction of its own, so undoing it restores what it discarded.
      </p>
      {outcome}
      {list}
    </section>
  )
}

/** A record's action, time, and its description or the details that stand in for it. */
function RecordSummary({ repo, record }: { repo: RepoLocator; record: UndoRecord }) {
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">#{record.transaction}</span>
        <span className="font-medium">{record.action}</span>
        {record.undone && <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">Undone</span>}
        {record.created_at && <span className="ml-auto text-muted-foreground"><Instant value={record.created_at} /></span>}
      </div>
      {record.details.length === 0 ? (
        <p className="mt-1 break-words text-muted-foreground">{record.description}</p>
      ) : (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {record.details.map((detail, index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">
                {detail.target ? <Link to={undoTargetRoute(repo, detail.target)} className={linkClass}>{detail.text}</Link> : detail.text}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

/** What a completed undo did: its own record, and the undo that reverses it where the viewer may. */
function UndoResultPanel({ repo, result, disabled, onReverse }: { repo: RepoLocator; result: UndoResult; disabled: boolean; onReverse(): void }) {
  const reverse = result.record.actions.undo
  return (
    <section aria-label="Undo result" className="mt-4 rounded-md border border-emerald-600/40 bg-emerald-600/5 px-4 py-3">
      <p role="status" className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Undone. Haxy recorded the undo as transaction {result.record.transaction}:</p>
      <div className="mt-2"><RecordSummary repo={repo} record={result.record} /></div>
      {reverse.available ? (
        <Button variant="outline" size="sm" className="mt-3" disabled={disabled} onClick={onReverse}><Undo2 />Reverse this undo</Button>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{reverse.reason.message}</p>
      )}
    </section>
  )
}

function Confirmation({ choice, failure, busy, onConfirm, onCancel }: { choice: Choice; failure: Failure | null; busy: boolean; onConfirm(): void; onCancel(): void }) {
  const confirmButton = useRef<HTMLButtonElement>(null)
  useEffect(() => confirmButton.current?.focus(), [choice])
  const { record, newest } = choice
  const question = choice.reversal
    ? `Reverse this undo? Undoing transaction ${record.transaction} restores what it discarded.`
    : `Undo transaction ${record.transaction} (${record.action})${record.transaction === newest ? "" : " and every transaction after it"}? The repository returns to its state before it. You can reverse this by undoing the undo.`
  return (
    <div role="group" aria-label={`Confirm: undo transaction ${record.transaction}`} className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3">
      <p className="text-sm">{question}</p>
      {failure && <div className="mt-2"><FailureMessage failure={failure} /></div>}
      <div className="mt-3 flex gap-2">
        <Button ref={confirmButton} variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
          {busy && <LoaderCircle className="animate-spin" />}
          {choice.reversal ? "Reverse the undo" : "Undo"}
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  )
}
