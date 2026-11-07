import { useEffect, useRef, useState, type FormEvent } from "react"
import { KeyRound, LoaderCircle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, TextField, failureOf, type Failure } from "@/components/form"
import { FailureState } from "@/components/listing"
import { ApiError } from "@/lib/api"
import { addKey, listKeys, removeKey, type SshKey } from "@/lib/account"
import { useResource } from "@/lib/resource"

/** A key's comment, or its type when it has none (as the TUI labels it). */
const keyLabel = (key: SshKey) => key.comment ?? key.type

/** The viewer's SSH keys with their fingerprints; adding one, and removing one after confirming. */
export function KeysSection({ viewer }: { viewer: string }) {
  const keys = useResource("account keys", (signal) => listKeys({ signal }))
  // Said when a removal's outcome was unknown and the list was read again.
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <section aria-labelledby="keys-heading" className="max-w-2xl">
      <h2 id="keys-heading" className="text-xl font-semibold">SSH keys</h2>
      <p className="mt-1 text-sm text-muted-foreground">Keys that may push to your repositories over SSH. Fingerprints are the SHA256 form <code>ssh-keygen -l</code> prints.</p>
      <AddKeyForm viewer={viewer} onAdded={keys.reload} />
      {notice && <p className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">{notice}</p>}
      {keys.kind === "failed" && <FailureState title="Couldn't load your SSH keys" error={keys.error} onRetry={keys.reload} />}
      {keys.kind === "loaded" && (
        keys.data.items.length === 0
          ? <p className="mt-6 text-sm text-muted-foreground">You have no SSH keys.</p>
          : (
            <ul aria-label="SSH keys" className="mt-6 divide-y rounded-xl border bg-card">
              {keys.data.items.map((key) => (
                <KeyRow key={key.fingerprint} viewer={viewer} sshKey={key}
                  onRemoved={() => { setNotice(null); keys.reload() }}
                  onUncertain={(message) => { setNotice(message); keys.reload() }} />
              ))}
            </ul>
          )
      )}
    </section>
  )
}

function AddKeyForm({ viewer, onAdded }: { viewer: string; onAdded(): void }) {
  const [key, setKey] = useState("")
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      await addKey(viewer, key)
      setKey("")
      onAdded()
    } catch (error) {
      // A public key isn't secret: keep it to correct.
      const failure = failureOf(error, "Adding the key failed.")
      setFailure(failure)
      // When the outcome is unknown the key may have been added: show what is there.
      if (failure.unknown) onAdded()
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={submit} noValidate>
      {failure && <FailureMessage failure={failure} />}
      <TextField label="Public key" name="key" value={key} onValue={setKey} error={failure?.fields.key} placeholder="ssh-ed25519 AAAA… you@host"
        autoComplete="off" autoCapitalize="none" spellCheck={false} className="font-mono" />
      <Button type="submit" disabled={pending}>
        {pending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
        Add key
      </Button>
    </form>
  )
}

function KeyRow({ viewer, sshKey, onRemoved, onUncertain }: { viewer: string; sshKey: SshKey; onRemoved(): void; onUncertain(message: string): void }) {
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const removeButton = useRef<HTMLButtonElement>(null)
  const label = keyLabel(sshKey)

  useEffect(() => {
    if (confirming) confirmButton.current?.focus()
  }, [confirming])

  async function remove() {
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      await removeKey(viewer, sshKey.fingerprint)
      onRemoved()
    } catch (error) {
      const failed = failureOf(error, "Removing the key failed.")
      // Never offer the removal again before the list is read: the key may
      // be gone already (an unknown outcome), or is (not found).
      if (failed.unknown) return onUncertain(`${failed.cause} The key ${label} may or may not have been removed; the list below shows your keys as they are now.`)
      if (error instanceof ApiError && error.code === "not_found") return onRemoved()
      setFailure(failed)
      setPending(false)
    }
  }

  function cancel() {
    setConfirming(false)
    setFailure(null)
    // Focus returns to the button that opened the confirmation.
    requestAnimationFrame(() => removeButton.current?.focus())
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium break-all">{label}</p>
          <p className="mt-0.5 font-mono text-xs break-all text-muted-foreground">{sshKey.fingerprint}</p>
          {sshKey.comment !== null && <p className="mt-0.5 text-xs text-muted-foreground">{sshKey.type}</p>}
        </div>
        {!confirming && (
          <Button ref={removeButton} variant="outline" size="sm" aria-label={`Remove ${label}`} onClick={() => setConfirming(true)}><Trash2 />Remove</Button>
        )}
      </div>
      {confirming && (
        <div role="group" aria-label={`Confirm removing ${label}`} className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm">Remove this key? Git over SSH with it stops working.</p>
          {failure && <div className="mt-2"><FailureMessage failure={failure} /></div>}
          <div className="mt-3 flex gap-2">
            <Button ref={confirmButton} variant="destructive" size="sm" onClick={remove} disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />}
              Remove key
            </Button>
            <Button variant="outline" size="sm" onClick={cancel} disabled={pending}>Cancel</Button>
          </div>
        </div>
      )}
    </li>
  )
}
