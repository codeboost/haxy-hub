import { useId, useRef, useState, type FormEvent } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { ApiError, type FieldErrors } from "@/lib/api"
import { returnPath } from "@/lib/session"

const inputClass =
  "mt-1.5 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"

/** `/login?next=<path>`: logs in, then returns to `next` (a path in this app). */
export function LoginPage() {
  const { check } = useConnection()
  const { viewer } = useSession()
  const [searchParams] = useSearchParams()
  const next = returnPath(searchParams.get("next"))

  if (check?.kind === "connected" && check.status.mode === "local") {
    return (
      <section className="max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">No accounts in local mode</h1>
        <p className="mt-3 text-muted-foreground">Haxy is serving a local repository. Local mode works without accounts, so there is nothing to log in to.</p>
        <Link to={next} className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Continue</Link>
      </section>
    )
  }

  if (viewer) {
    return (
      <section className="max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">Already logged in</h1>
        <p className="mt-3 text-muted-foreground">You are logged in as <strong className="text-foreground">{viewer.name}</strong>.</p>
        <Link to={next} className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Continue</Link>
      </section>
    )
  }

  return <LoginForm next={next} />
}

function LoginForm({ next }: { next: string }) {
  const { logIn } = useSession()
  const navigate = useNavigate()
  const id = useId()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const passwordInput = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setFormError(null)
    setFieldErrors({})
    try {
      await logIn(username, password)
      // The login page isn't worth going back to.
      await navigate(next, { replace: true })
    } catch (error) {
      // Keep the username, never the password.
      setPassword("")
      const apiError = error instanceof ApiError ? error : null
      setFormError(apiError?.message ?? "Logging in failed.")
      setFieldErrors(apiError?.fieldErrors ?? {})
      setPending(false)
      passwordInput.current?.focus()
    }
  }

  const field = (name: "username" | "password") => ({
    id: `${id}-${name}`,
    name,
    "aria-invalid": fieldErrors[name] ? true : undefined,
    "aria-describedby": fieldErrors[name] ? `${id}-${name}-error` : undefined,
  })

  return (
    <section className="max-w-sm">
      <h1 className="text-3xl font-semibold tracking-tight">Log in</h1>
      <p className="mt-3 text-sm text-muted-foreground">Use your Haxy account. You'll return to where you were.</p>
      <form className="mt-8 space-y-5" onSubmit={submit} noValidate>
        {formError && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{formError}</p>}
        <div>
          <label htmlFor={`${id}-username`} className="text-sm font-medium">Username</label>
          <input {...field("username")} className={inputClass} autoComplete="username" autoCapitalize="none" spellCheck={false} required
            value={username} onChange={(event) => setUsername(event.target.value)} />
          {fieldErrors.username && <p id={`${id}-username-error`} className="mt-1 text-xs text-destructive">{fieldErrors.username}</p>}
        </div>
        <div>
          <label htmlFor={`${id}-password`} className="text-sm font-medium">Password</label>
          <input {...field("password")} ref={passwordInput} type="password" className={inputClass} autoComplete="current-password" required
            value={password} onChange={(event) => setPassword(event.target.value)} />
          {fieldErrors.password && <p id={`${id}-password-error`} className="mt-1 text-xs text-destructive">{fieldErrors.password}</p>}
        </div>
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <LoaderCircle className="animate-spin" />}
          Log in
        </Button>
      </form>
    </section>
  )
}
