import { Markdown } from "@/components/Markdown"
import { FailureState, LoadingState, UnavailableState } from "@/components/listing"
import { getAbout } from "@/lib/discovery"
import { useResource } from "@/lib/resource"

export function AboutPage() {
  const about = useResource("about", (signal) => getAbout({ signal }))
  switch (about.kind) {
    case "loading":
      return <LoadingState>Loading the about page…</LoadingState>
    case "failed":
      if (about.error.code === "unsupported") {
        return <UnavailableState title="About">The forge's about page belongs to a multi-user Haxy server; it isn't available in local mode.</UnavailableState>
      }
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">About</h1>
          <FailureState title="Couldn't load the about page" error={about.error} onRetry={about.reload} />
        </>
      )
    case "loaded":
      return (
        <article className="max-w-3xl">
          <h1 className="mb-6 text-2xl font-semibold tracking-tight">{about.data.title ?? "About"}</h1>
          <Markdown blocks={about.data.blocks} />
        </article>
      )
  }
}
