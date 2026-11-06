import type { ReactNode } from "react"
import { Link } from "react-router"
import { ArrowLeft, CheckCircle2, CircleDot, MessageSquare } from "lucide-react"
import { Avatar } from "@/components/Avatar"
import type { ThreadDetail } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { AuthorName, Instant, authorText } from "./ThreadParts"

/** A kind with one list (discussions) has no status to show. */
export function hasStatus<Status extends string>(config: ThreadConfig<Status>): boolean {
  return config.statuses.length > 1
}

/** The thread's status: its kind's first (open) filled in, any other muted. */
function StatusPill<Status extends string>({ config, status }: { config: ThreadConfig<Status>; status: Status }) {
  const first = status === config.statuses[0]
  const Icon = first ? CircleDot : CheckCircle2
  const tone = first ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground ring-1 ring-border"
  return (
    <span role="status" aria-label="Status" className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium ${tone}`}>
      <Icon size={14} aria-hidden />{config.statusLabels[status]}
    </span>
  )
}

function commentCount(count: number): string {
  return `${count} ${count === 1 ? "comment" : "comments"}`
}

/** The way back to the thread's list, its title, status and who opened it when, with the thread's `actions` beside them. */
export function ThreadHeader<Status extends string>({ config, thread, back, actions }: { config: ThreadConfig<Status>; thread: ThreadDetail<Status>; back: string; actions: ReactNode }) {
  return (
    <>
      <Link to={back} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
        <ArrowLeft size={14} aria-hidden />{config.statusLabels[thread.status]} {config.plural.toLowerCase()}
      </Link>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b pb-5">
        <div className="min-w-0">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">{thread.title}</h2>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {hasStatus(config) && <StatusPill config={config} status={thread.status} />}
            <span><AuthorName author={thread.author} /> opened <Instant value={thread.created_at} /></span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1"><MessageSquare size={14} aria-hidden />{commentCount(thread.comment_count)}</span>
          </div>
        </div>
        {actions}
      </header>
    </>
  )
}

/** The description as the thread's opening post, under who opened it when. */
export function OpeningPost<Status extends string>({ config, thread, children }: { config: ThreadConfig<Status>; thread: ThreadDetail<Status>; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Avatar name={authorText(thread.author)} size="lg" className="mt-1 hidden sm:grid" />
      <section aria-label="Description" className="min-w-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-xs">
        <header className="flex flex-wrap items-center gap-x-1.5 border-b bg-secondary/60 px-4 py-2.5 text-sm text-muted-foreground">
          <span className="font-medium text-foreground"><AuthorName author={thread.author} /></span> opened this {config.noun.toLowerCase()} on <Instant value={thread.created_at} />
        </header>
        <div className="p-4 sm:p-5">{children}</div>
      </section>
    </div>
  )
}
