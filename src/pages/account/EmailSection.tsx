import { useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { changeEmail, getAccount, type Account } from "@/lib/account"

/** The viewer's email address, under Haxy's existing rules (required, not used by another account). */
export function EmailSection({ account }: { account: Account }) {
  const [email, setEmail] = useState(account.email)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<{ kind: "saved" } | { kind: "failed"; failure: Failure } | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setOutcome(null)
    try {
      const saved = await changeEmail(account.name, email)
      setEmail(saved.email)
      setOutcome({ kind: "saved" })
    } catch (error) {
      const failure = failureOf(error, "Saving the email failed.")
      setOutcome({ kind: "failed", failure })
      // The change may have landed: show the email Haxy has now.
      if (failure.unknown) await getAccount().then((current) => { if (current.name === account.name) setEmail(current.email) }, () => {})
    } finally {
      setPending(false)
    }
  }

  const failure = outcome?.kind === "failed" ? outcome.failure : null
  return (
    <section aria-labelledby="email-heading" className="max-w-sm">
      <h2 id="email-heading" className="text-xl font-semibold">Email address</h2>
      <form className="mt-4 space-y-4" onSubmit={submit} noValidate>
        {failure && <FailureMessage failure={failure} />}
        {outcome?.kind === "saved" && <FormMessage kind="success">Email saved.</FormMessage>}
        <TextField label="Email" name="email" type="email" value={email} onValue={setEmail} error={failure?.fields.email} autoComplete="email" required />
        <Button type="submit" disabled={pending}>
          {pending && <LoaderCircle className="animate-spin" />}
          Save email
        </Button>
      </form>
    </section>
  )
}
