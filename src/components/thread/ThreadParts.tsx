import { useState } from "react"
import { Link, useNavigate } from "react-router"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Count } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { threadLabelsRoute, threadsRoute, type FilterLink, type ThreadAssignee, type ThreadAuthor, type ThreadFilters } from "@/lib/threads"
import { conflictsRoute, type ConflictKind } from "@/lib/conflicts"
import { countText, linkClass, type ThreadConfig } from "./config"

// Small building blocks of the thread pages. Every link is an absolute route
// from lib/threads.ts, never relative to the current URL.

/** The tabs of a thread section: one list per status (with its count when known), the labels, then the metadata conflicts of a kind that has them. */
export function ThreadTabs<Status extends string>({ repo, config, current, search, counts }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  current: Status | "labels" | "conflicts" | null
  search: string
  counts?: Record<Status, Count>
}) {
  const tabClass = "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm"
  const tab = (active: boolean) => `${tabClass} ${active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`
  return (
    <nav aria-label={`${config.noun} lists`} className="mt-6 flex flex-wrap gap-1 border-b">
      {config.statuses.map((status) => {
        const count = countText(counts?.[status])
        return (
          <Link key={status} to={threadsRoute(repo, config.kind, config.statuses, status, { search })} aria-current={current === status ? "page" : undefined} className={tab(current === status)}>
            {config.statusLabels[status]}
            {count && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{count}</span>}
          </Link>
        )
      })}
      <Link to={threadLabelsRoute(repo, config.kind, { search })} aria-current={current === "labels" ? "page" : undefined} className={tab(current === "labels")}>Labels</Link>
      {config.conflicts && <Link to={conflictsRoute(repo, config.kind as ConflictKind)} aria-current={current === "conflicts" ? "page" : undefined} className={tab(current === "conflicts")}>Conflicts</Link>}
    </nav>
  )
}

/** Haxy's thread search: words, `label:<name>` and `assignee:<name or email>`, parsed by Haxy. */
export function ThreadSearchForm({ label, search, target, placeholder = "Words, label:name, assignee:name" }: { label: string; search: string; target(search: string): string; placeholder?: string }) {
  const navigate = useNavigate()
  const [value, setValue] = useState(search)
  return (
    <form
      role="search"
      className="mt-4 flex max-w-xl gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        // A new search starts from the first page.
        void navigate(target(value.trim()))
      }}
    >
      <label className="sr-only" htmlFor="thread-search">{label}</label>
      <input
        id="thread-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <Button type="submit" variant="outline"><Search />Search</Button>
    </form>
  )
}

/** The search as Haxy parsed it, so readers see which filters apply. */
export function FilterSummary({ filters, noun }: { filters: ThreadFilters; noun: string }) {
  const parts: string[] = []
  if (filters.labels.length > 0) parts.push(`labelled ${filters.labels.join(" and ")}`)
  if (filters.assignees.length > 0) parts.push(`assigned to ${filters.assignees.join(" and ")}`)
  if (filters.words) parts.push(`matching “${filters.words}”`)
  if (parts.length === 0) return null
  return (
    <>
      <p role="status" aria-label="Active filters" className="mt-3 text-sm text-muted-foreground">Showing {noun.toLowerCase()} {parts.join(", ")}.</p>
      {filters.assignee_not_found && (
        <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          {filters.assignees.length === 1 ? `No account is named ${filters.assignees[0]}` : "An assignee filter names no account"}, so nothing is assigned to it. Assign by email to name someone without an account.
        </p>
      )}
    </>
  )
}

export function AuthorName({ author }: { author: ThreadAuthor }) {
  switch (author.kind) {
    case "user": return <Link to={`/users/${encodeURIComponent(author.name)}`} className={linkClass}>{author.name}</Link>
    case "email": return <span>{author.email}</span>
    case "unknown": return <span>someone</span>
  }
}

export function Instant({ value }: { value: string }) {
  const date = new Date(value)
  return <time dateTime={value} title={value}>{date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</time>
}

const chipClass = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

/** Labels, each a link to the list filtered by it (`to` turns a search into that list's route). */
export function LabelLinks({ labels, to }: { labels: FilterLink[]; to(search: string): string }) {
  return labels.map((label) => <Link key={label.name} to={to(label.search)} className={chipClass}>{label.name}</Link>)
}

/** Assignees, by account name or else by email, each a link to the list of what they hold. */
export function AssigneeLinks({ assignees, to }: { assignees: ThreadAssignee[]; to(search: string): string }) {
  return assignees.map((assignee) => {
    const name = assignee.name ?? assignee.email ?? ""
    return <Link key={name} to={to(assignee.search)} className={chipClass}>{name}</Link>
  })
}

/** A thread section that isn't available here, e.g. turned off in the repository's settings. */
export function SectionUnavailable({ children }: { children: string }) {
  return <p role="status" className="mt-6 rounded-xl border border-dashed p-8 text-center text-muted-foreground">{children}</p>
}
