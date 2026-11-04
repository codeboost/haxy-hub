import { useRef, useState, type FormEvent } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { changePassword } from "@/lib/account"

/** Changes the viewer's password, checking the current one and the confirmation. */
export function PasswordSection({ name }: { name: string }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [again, setAgain] = useState("")
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<{ kind: "changed" } | { kind: "failed"; failure: Failure } | null>(null)
  const currentInput = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setOutcome(null)
    try {
      await changePassword(name, { current_password: current, new_password: next, new_password_again: again })
      setOutcome({ kind: "changed" })
    } catch (error) {
      setOutcome({ kind: "failed", failure: failureOf(error, "Changing the password failed.") })
      currentInput.current?.focus()
    } finally {
      // Passwords are never kept, whatever the outcome.
      setCurrent("")
      setNext("")
      setAgain("")
      setPending(false)
    }
  }

  const fields = outcome?.kind === "failed" ? outcome.failure.fields : {}
  return (
    <section aria-labelledby="password-heading" className="max-w-sm">
      <h2 id="password-heading" className="text-xl font-semibold">Password</h2>
      <form className="mt-4 space-y-4" onSubmit={submit} noValidate>
        {outcome?.kind === "failed" && <FailureMessage failure={outcome.failure} />}
        {outcome?.kind === "changed" && <FormMessage kind="success">Password changed.</FormMessage>}
        {/* Lets password managers file the change under this account. */}
        <input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
        <TextField ref={currentInput} label="Current password" name="current_password" type="password" value={current} onValue={setCurrent} error={fields.current_password} autoComplete="current-password" required />
        <TextField label="New password" name="new_password" type="password" value={next} onValue={setNext} error={fields.new_password} autoComplete="new-password" required />
        <TextField label="Confirm new password" name="new_password_again" type="password" value={again} onValue={setAgain} error={fields.new_password_again} autoComplete="new-password" required />
        <Button type="submit" disabled={pending}>
          {pending && <LoaderCircle className="animate-spin" />}
          Change password
        </Button>
      </form>
    </section>
  )
}
