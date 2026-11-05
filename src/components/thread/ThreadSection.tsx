import { Link } from "react-router"
import { useListParams } from "@/components/listing"
import type { RepoLocator } from "@/lib/repo"
import { threadView, threadsRoute } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { ThreadDetailView } from "./ThreadDetail"
import { ThreadEditView } from "./ThreadEdit"
import { ThreadNewView } from "./ThreadNew"
import { ThreadLabelsView, ThreadListView } from "./ThreadList"

/**
 * A repository's threads of one kind, as `<repo>/<kind>/<tail>` names them:
 * a status's list (`?search=&cursor=`), the labels, one thread by id, or
 * the forms that open (`new`) and edit (`<id>/edit`) one.
 * `unavailable`, when set, says why the kind is off; it is shown when Haxy
 * answers not found, instead of that answer.
 */
export function ThreadSection<Status extends string>({ repo, config, tail, unavailable = null }: { repo: RepoLocator; config: ThreadConfig<Status>; tail: string; unavailable?: string | null }) {
  const { search, cursor } = useListParams()
  const view = threadView(config.statuses, tail)
  switch (view.kind) {
    case "list":
      return <ThreadListView repo={repo} config={config} status={view.status} search={search} cursor={cursor} unavailable={unavailable} />
    case "labels":
      return <ThreadLabelsView repo={repo} config={config} search={search} cursor={cursor} unavailable={unavailable} />
    case "thread":
      return <ThreadDetailView key={view.id} repo={repo} config={config} id={view.id} unavailable={unavailable} />
    case "new":
      return <ThreadNewView repo={repo} config={config} unavailable={unavailable} />
    case "edit":
      return <ThreadEditView key={view.id} repo={repo} config={config} id={view.id} unavailable={unavailable} />
    case "unknown":
      return (
        <section className="mt-6">
          <h2 className="text-2xl font-semibold tracking-tight">Page not found</h2>
          <Link to={threadsRoute(repo, config.kind, config.statuses, config.statuses[0])} className={`mt-4 inline-block text-sm ${linkClass}`}>All {config.plural.toLowerCase()}</Link>
        </section>
      )
  }
}
