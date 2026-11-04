/**
 * Types and a fetch helper for Haxy's JSON API. They mirror haxy's src/api.zig;
 * docs/api-conventions.md is the contract both follow.
 */

// --- Errors -----------------------------------------------------------------

/** Stable codes from the backend's error envelope. Switch on these, never on messages. */
export const errorCodes = ["validation", "unauthenticated", "forbidden", "not_found", "conflict", "unsupported", "internal"] as const
export type ErrorCode = (typeof errorCodes)[number]

/** Codes the client produces itself when no envelope could be read. */
export type ClientErrorCode = "unreachable" | "timeout" | "invalid_response"

export type FieldError = { field: string; message: string }

export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; field_errors?: FieldError[] }
}

export class ApiError extends Error {
  readonly code: ErrorCode | ClientErrorCode
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number
  readonly fieldErrors: FieldError[]

  constructor(code: ErrorCode | ClientErrorCode, message: string, status: number, fieldErrors: FieldError[] = []) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = status
    this.fieldErrors = fieldErrors
  }

  /** The message for one form field, if the backend rejected it. */
  fieldError(field: string): string | undefined {
    return this.fieldErrors.find((error) => error.field === field)?.message
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads an error envelope, or returns null when `body` isn't one. Unknown codes read as "internal". */
export function parseErrorEnvelope(body: unknown): ErrorEnvelope["error"] | null {
  if (!isRecord(body) || !isRecord(body.error)) return null
  const { code, message, field_errors: fieldErrors } = body.error
  if (typeof code !== "string" || typeof message !== "string") return null
  const known = (errorCodes as readonly string[]).includes(code) ? (code as ErrorCode) : "internal"
  const fields = Array.isArray(fieldErrors)
    ? fieldErrors.filter((entry): entry is FieldError => isRecord(entry) && typeof entry.field === "string" && typeof entry.message === "string")
    : []
  return fields.length > 0 ? { code: known, message, field_errors: fields } : { code: known, message }
}

// --- Pagination -------------------------------------------------------------

/** How many results a listing has: exact, at least `value`, or not known. */
export type Count = { kind: "exact"; value: number } | { kind: "at_least"; value: number } | { kind: "unknown" }

export type PageInfo = {
  has_more: boolean
  /** Opaque; pass back unchanged as `cursor` to fetch the next page. Null on the last page. */
  next_cursor: string | null
  count: Count
}

export type Page<T> = { items: T[]; page: PageInfo }

// --- Identifiers and timestamps ---------------------------------------------

/**
 * Opaque identifiers (event IDs, repository identities, Git object IDs, and
 * any integer that may exceed 2^53 - 1) are strings. Compare them and send
 * them back; never parse them or do arithmetic on them.
 */
export type OpaqueId<Kind extends string> = string & { readonly __opaque?: Kind }
export type EventId = OpaqueId<"event">
export type ObjectId = OpaqueId<"object">

/** An RFC 3339 instant in UTC with a `Z` suffix, e.g. "2026-11-04T14:03:00Z". */
export type Timestamp = string

// --- Capabilities -----------------------------------------------------------

/** Why an action is unavailable to this viewer right now. */
export type UnavailableCode = "unauthenticated" | "forbidden" | "unsupported" | "disabled" | "conflict"

export type ActionAvailability =
  | { available: true }
  | { available: false; reason: { code: UnavailableCode; message: string } }

/** Per-resource action availability, keyed by action name. The backend rechecks on execution. */
export type Capabilities<Action extends string> = { actions: Record<Action, ActionAvailability> }

// --- Requests ---------------------------------------------------------------

/**
 * Client-side timeouts. Only the status check is short; ordinary reads get a
 * generous bound, and writes have none, so long merges, syncs and uploads are
 * never cut off by the client (the backend reports their outcome).
 */
export const timeouts = {
  status: 10_000,
  read: 30_000,
  write: null,
} as const

export type RequestOptions = Omit<RequestInit, "signal"> & {
  signal?: AbortSignal
  /** Milliseconds, or null for no client timeout. Defaults by method (see `timeouts`). */
  timeoutMs?: number | null
}

/**
 * Reads a JSON response body. Transport failures while the body arrives
 * (timeout, dropped connection, cancellation) reject; a non-JSON or malformed
 * body resolves to undefined, for the caller to report as unreadable.
 */
export async function readJsonBody(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("application/json")) return undefined
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Vite answers with these itself when it cannot reach the configured backend. */
export const proxyFailureStatuses = new Set([502, 503, 504])

/** Fetches `path` (under /api/) and returns its JSON body, or throws an ApiError. */
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { signal, timeoutMs, headers, ...init } = options
  const method = (init.method ?? "GET").toUpperCase()
  const limit = timeoutMs !== undefined ? timeoutMs : method === "GET" || method === "HEAD" ? timeouts.read : timeouts.write
  const timeout = limit === null ? undefined : AbortSignal.timeout(limit)
  const signals = [signal, timeout].filter((value): value is AbortSignal => value !== undefined)

  // Normalise every HeadersInit form (object, tuples, Headers) before adding defaults.
  const merged = new Headers(headers)
  if (!merged.has("Accept")) merged.set("Accept", "application/json")

  // Timeouts, dropped connections and caller cancellation can strike while
  // the body is still arriving, so they are handled for the body read too.
  const transportFailure = (error: unknown): never => {
    if (signal?.aborted) throw error
    if (timeout?.aborted) throw new ApiError("timeout", `Haxy did not answer within ${Math.round((limit ?? 0) / 1000)} seconds.`, 0)
    throw new ApiError("unreachable", "Haxy Hub could not be reached.", 0)
  }

  let response: Response
  let body: unknown
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      method,
      headers: merged,
      signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    })
    body = await readJsonBody(response)
  } catch (error) {
    return transportFailure(error)
  }

  if (response.ok) {
    if (body === undefined) throw new ApiError("invalid_response", "Haxy returned a response this app could not read.", response.status)
    return body as T
  }
  const envelope = parseErrorEnvelope(body)
  if (envelope) throw new ApiError(envelope.code, envelope.message, response.status, envelope.field_errors)
  if (proxyFailureStatuses.has(response.status)) {
    throw new ApiError("unreachable", "Haxy Hub could not connect to the Haxy backend.", response.status)
  }
  throw new ApiError("invalid_response", `Haxy returned HTTP ${response.status} without an error description.`, response.status)
}

export function getJson<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
  return requestJson<T>(path, { ...options, method: "GET" })
}
