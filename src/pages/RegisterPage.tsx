import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, TextField, failureOf, type Failure } from "@/components/form"
import { UnavailableState } from "@/components/listing"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { register } from "@/lib/account"

/** `/register`: creates an account under Haxy's sign-up rules and logs in as it. */
export function RegisterPage() {
  const { check } = useConnection()
  const { viewer } = useSession()

  if (check?.kind === "connected" && check.status.mode === "local") {
    return <UnavailableState title="Create an account">Local mode serves a single repository without accounts, so there is nothing to register for.</UnavailableState>
  }

  if (viewer) {
    return (
      <section className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Already logged in</h1>
        <p className="mt-3 text-muted-foreground">You are logged in as <strong className="text-foreground">{viewer.name}</strong>. Log out to create another account.</p>
        <Link to="/account" className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Your account</Link>
      </section>
    )
  }

  return <RegisterForm />
}

function RegisterForm() {
  const { changeSession } = useSession()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [passwordAgain, setPasswordAgain] = useState("")
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      await changeSession(() => register({ name, email, password, password_again: passwordAgain }))
      await navigate("/account", { replace: true })
    } catch (error) {
      // Keep the name and email, never the passwords.
      setPassword("")
      setPasswordAgain("")
      setFailure(failureOf(error, "Creating the account failed."))
      setPending(false)
    }
  }

  const fields = failure?.fields ?? {}
  return (
    <section className="max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="mt-3 text-sm text-muted-foreground">Already have one? <Link to="/login" className="text-primary underline-offset-4 hover:underline">Log in</Link>.</p>
      <form className="mt-8 space-y-5" onSubmit={submit} noValidate>
        {failure && (
          <FailureMessage failure={failure}>
            {failure.unknown ? (
              // The account may exist without this browser being signed in to it.
              <>Haxy couldn't confirm the account was created ({failure.cause}). It may have been created: try
                to <Link to="/login" className="font-medium underline underline-offset-4">Log in</Link> before registering again.</>
            ) : failure.message}
          </FailureMessage>
        )}
        <TextField label="Username" name="name" value={name} onValue={setName} error={fields.name} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        <TextField label="Email" name="email" type="email" value={email} onValue={setEmail} error={fields.email} autoComplete="email" required />
        <TextField label="Password" name="password" type="password" value={password} onValue={setPassword} error={fields.password} autoComplete="new-password" required />
        <TextField label="Confirm password" name="password_again" type="password" value={passwordAgain} onValue={setPasswordAgain} error={fields.password_again} autoComplete="new-password" required />
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <LoaderCircle className="animate-spin" />}
          Create account
        </Button>
      </form>
    </section>
  )
}
