import { Link } from "react-router"
import { Lock } from "lucide-react"
import type { RepoHeaderInfo } from "@/app/repoHeader"

const crumbClass = "rounded px-1 hover:bg-accent"

/** The open repository as the header's context: `/ owner / name`, the page's main heading. */
export function RepoBreadcrumb({ info }: { info: RepoHeaderInfo }) {
  return (
    <h1 className="flex min-w-0 items-center gap-1.5 text-sm">
      <span aria-hidden className="text-muted-foreground">/</span>
      {info.owner !== null && (
        <>
          <Link to={`/users/${encodeURIComponent(info.owner)}`} className={`${crumbClass} text-muted-foreground hover:text-foreground`}>{info.owner}</Link>
          <span aria-hidden className="text-muted-foreground">/</span>
        </>
      )}
      <Link to={info.home} className={`${crumbClass} truncate font-semibold`}>{info.name}</Link>
      {info.isPrivate && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground"><Lock size={11} aria-hidden />Private</span>
      )}
    </h1>
  )
}

function tabClass(active: boolean): string {
  return `-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`
}

/** The repository's sections, as the header's second row. Those Haxy Hub doesn't have yet are listed, not linked. */
export function RepoTabs({ info }: { info: RepoHeaderInfo }) {
  return (
    <nav aria-label="Repository sections" className="flex flex-wrap gap-x-1">
      {info.tabs.map((tab) => {
        const active = tab.section === info.current
        return tab.href ? (
          <Link key={tab.section} to={tab.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>{tab.label}</Link>
        ) : (
          <span key={tab.section} aria-disabled="true" title="Not available in Haxy Hub yet" className={tabClass(false)}>{tab.label}</span>
        )
      })}
    </nav>
  )
}
