import { Link, useLocation } from "react-router"

export function NotFoundPage() {
  const { pathname } = useLocation()
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 text-muted-foreground">
        Haxy Hub has no page at <code className="rounded bg-secondary px-1.5 py-0.5 text-sm break-all text-foreground">{pathname}</code>.
      </p>
      <Link to="/" className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Go to the home page</Link>
    </section>
  )
}
