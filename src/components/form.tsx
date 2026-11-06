import { useId, type ComponentProps, type ReactNode, type Ref } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ApiError, ViewerChangedError, type FieldErrors } from "@/lib/api"

const inputClass =
  "mt-1.5 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"

type FieldProps = Omit<ComponentProps<"input">, "value" | "onChange" | "id"> & {
  label: string
  name: string
  value: string
  onValue(value: string): void
  /** The backend's message for this field, shown beside it. */
  error?: string
  hint?: ReactNode
  ref?: Ref<HTMLInputElement>
}

/** A labelled text input that shows its field error beside it. */
export function TextField({ label, name, value, onValue, error, hint, ref, className, ...input }: FieldProps) {
  const id = useId()
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ")
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <input {...input} ref={ref} id={id} name={name} className={className ? `${inputClass} ${className}` : inputClass} value={value} onChange={(event) => onValue(event.target.value)}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy || undefined} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** A form-level message: an error (announced) or a confirmation. */
export function FormMessage({ kind, children }: { kind: "error" | "success"; children: ReactNode }) {
  return kind === "error"
    ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{children}</div>
    : <p role="status" className="rounded-md border border-emerald-600/40 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">{children}</p>
}

/** What a failed submission shows: the form's message and each field's. */
export type Failure = {
  message: string
  /** The error's own message, without the unknown-outcome explanation. */
  cause: string
  fields: FieldErrors
  /**
   * The backend may or may not have made the change (no answer, a timeout, an
   * internal error, or an answer that couldn't be read): reload authoritative
   * state before offering another attempt.
   */
  unknown: boolean
  /** Someone else is signed in now (e.g. from another tab): only a reload helps. */
  viewerChanged: boolean
}

/** API codes after which a write's outcome is unknown; see "Errors" in docs/api-conventions.md. */
const unknownOutcomeCodes = new Set(["timeout", "unreachable", "internal", "invalid_response"])

export function failureOf(error: unknown, fallback: string): Failure {
  if (error instanceof ViewerChangedError) return { message: error.message, cause: error.message, fields: {}, unknown: false, viewerChanged: true }
  if (!(error instanceof ApiError)) return { message: `${fallback} The change may or may not have been saved.`, cause: fallback, fields: {}, unknown: true, viewerChanged: false }
  if (unknownOutcomeCodes.has(error.code)) {
    return { message: `${error.message} The change may or may not have been saved.`, cause: error.message, fields: {}, unknown: true, viewerChanged: false }
  }
  return { message: error.message, cause: error.message, fields: error.fieldErrors, unknown: false, viewerChanged: false }
}

/**
 * A failed submission's message, with a way to reload when someone else is
 * signed in now. When `shown` names the fields shown beside their inputs, the
 * errors of any other field are listed here (by `labels`, else their name),
 * so no reason is lost for want of a field to show it.
 */
export function FailureMessage({ failure, children, shown, labels = {} }: { failure: Failure; children?: ReactNode; shown?: readonly string[]; labels?: Record<string, string> }) {
  const elsewhere = shown ? Object.entries(failure.fields).filter(([field]) => !shown.includes(field)) : []
  return (
    <FormMessage kind="error">
      <p>{children ?? failure.message}</p>
      {elsewhere.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {elsewhere.map(([field, message]) => <li key={field}>{labels[field] ?? field}: {message}</li>)}
        </ul>
      )}
      {failure.viewerChanged && (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}><RefreshCw />Reload</Button>
      )}
    </FormMessage>
  )
}
