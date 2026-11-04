import { useState, type ReactNode } from "react"
import { Link, useSearchParams } from "react-router"
import { LoaderCircle, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ApiError, PageInfo } from "@/lib/api"

// Shared pieces of searchable, paginated list pages. The list's search and
// page live in the URL (`search`, `cursor`), so refresh and back/forward
// restore the same view.

/** The search term and opaque cursor a list page shows, from the URL. */
export function useListParams(): { search: string; cursor: string } {
  const [params] = useSearchParams()
  return { search: params.get("search") ?? "", cursor: params.get("cursor") ?? "" }
}

/** The URL query for a list position; empty values are left out. */
export function listQuery(search: string, cursor = ""): string {
  const params = new URLSearchParams()
  if (search) params.set("search", search)
  if (cursor) params.set("cursor", cursor)
  const text = params.toString()
  return text ? `?${text}` : ""
}

export function SearchForm({ label, search }: { label: string; search: string }) {
  const [, setParams] = useSearchParams()
  const [value, setValue] = useState(search)
  return (
    <form
      role="search"
      className="flex max-w-md gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const term = value.trim()
        // A new search starts from the first page.
        setParams(term ? { search: term } : {})
      }}
    >
      <label className="sr-only" htmlFor="list-search">{label}</label>
      <input
        id="list-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Names starting with…"
        className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <Button type="submit" variant="outline"><Search />Search</Button>
    </form>
  )
}

/** Links to the first and next pages. Previous pages are a browser back away. */
export function Pager({ page, search, cursor, noun }: { page: PageInfo; search: string; cursor: string; noun: string }) {
  if (!cursor && !page.has_more) return null
  const linkClass = "rounded-md border px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return (
    <nav aria-label={`${noun} pages`} className="mt-6 flex gap-3">
      {cursor && <Link to={listQuery(search)} className={linkClass}>First page</Link>}
      {page.next_cursor && <Link to={listQuery(search, page.next_cursor)} className={linkClass}>Next page</Link>}
    </nav>
  )
}

export function LoadingState({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="animate-spin" size={16} /> {children}
    </p>
  )
}

/** A list or page that is legitimately empty; never used for failures. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section aria-label={title} className="mt-6 rounded-xl border border-dashed p-8 text-center">
      <h2 className="font-medium">{title}</h2>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </section>
  )
}

/** A read that failed. Offers a retry; never shown for empty results. */
export function FailureState({ title, error, onRetry }: { title: string; error: ApiError; onRetry(): void }) {
  return (
    <section role="alert" className="mt-6 rounded-xl border border-destructive/40 bg-card p-6">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
      <Button className="mt-4" variant="outline" onClick={onRetry}><RefreshCw />Retry</Button>
    </section>
  )
}

/** A server-only view on a host that doesn't offer it (local mode). */
export function UnavailableState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p role="status" className="mt-3 max-w-xl text-muted-foreground">{children}</p>
    </section>
  )
}
