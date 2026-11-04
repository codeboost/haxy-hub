/**
 * Types and a fetch helper for Haxy's JSON API. They mirror haxy's src/api.zig;
 * docs/api-conventions.md is the contract both follow.
 */

// --- Errors -----------------------------------------------------------------

/** Stable codes from the backend's error envelope. Switch on these, never on messages. */
export const errorCodes = ["validation", "unauthenticated", "forbidden", "csrf", "not_found", "conflict", "unsupported", "internal"] as const
export type ErrorCode = (typeof errorCodes)[number]

/** Codes the client produces itself when no envelope could be read. */
export type ClientErrorCode = "unreachable" | "timeout" | "invalid_response"

/** Rejected request fields, keyed by the field name the client sent, each with its message. */
export type FieldErrors = Record<string, string>

export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; field_errors?: FieldErrors }
}

export class ApiError extends Error {
  readonly code: ErrorCode | ClientErrorCode
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number
  readonly fieldErrors: FieldErrors

  constructor(code: ErrorCode | ClientErrorCode, message: string, status: number, fieldErrors: FieldErrors = {}) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = status
    this.fieldErrors = fieldErrors
  }

  /** The message for one form field, if the backend rejected it. */
  fieldError(field: string): string | undefined {
    return Object.hasOwn(this.fieldErrors, field) ? this.fieldErrors[field] : undefined
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
  const fields: FieldErrors = isRecord(fieldErrors)
    ? Object.fromEntries(Object.entries(fieldErrors).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {}
  return Object.keys(fields).length > 0 ? { code: known, message, field_errors: fields } : { code: known, message }
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

/**
 * Query parameters a paginated route accepts. `cursor` is a previous page's
 * `next_cursor`, passed back unchanged; `page_size` is a request the backend
 * honours up to its own maximum for that route.
 */
export type PageQuery = { cursor?: string; page_size?: number }

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

// --- CSRF -------------------------------------------------------------------

/**
 * Every state-changing /api/ request (anything but GET and HEAD) must carry
 * this browser's CSRF token in this header and come from Haxy Hub's own
 * origin; see "Security notes" in docs/api-conventions.md. The token comes
 * from GET /api/v1/session and is bound to an HttpOnly cookie, so it is kept
 * in memory only. Login and logout rotate it.
 */
export const csrfHeader = "X-Haxy-CSRF"
export const sessionPath = "/api/v1/session"

let csrfToken: string | null = null
// Bumped whenever a login or logout starts or ends: they rotate the token,
// so a token read by a request that started before then is stale.
let csrfEpoch = 0

/**
 * For a session read starting now: records the token it returns, unless a
 * login or logout began or ended in the meantime (the read may then carry
 * the token the rotation replaced).
 */
export function csrfTokenReader(): (token: string) => void {
  const epoch = csrfEpoch
  return (token) => {
    if (epoch === csrfEpoch) csrfToken = token
  }
}

/** Marks the start of a login or logout: tokens from reads already in flight are discarded. */
export function beginCsrfRotation(): void {
  csrfEpoch++
}

/**
 * Marks the end of a login or logout: records the token it returned, or, when
 * it failed (possibly after the backend rotated it), forgets the token so the
 * next write reads a fresh one.
 */
export function endCsrfRotation(token: string | null): void {
  csrfEpoch++
  csrfToken = token
}

/** Forgets `token` if it is still the current one, so the next write reads a fresh token. */
function forgetCsrfToken(token: string | null): void {
  if (token !== null && csrfToken === token) csrfToken = null
}

/** The current token, read from the session route the first time a write needs one. */
async function tokenForWrite(signal?: AbortSignal): Promise<string> {
  for (;;) {
    if (csrfToken !== null) return csrfToken
    const record = csrfTokenReader()
    const body = await requestJson<unknown>(sessionPath, { method: "GET", signal })
    const token = isRecord(body) && typeof body.csrf_token === "string" ? body.csrf_token : null
    if (token === null) throw new ApiError("invalid_response", "Haxy returned a session this app could not read.", 200)
    record(token)
    // Unrecorded only if a login or logout started or ended during this read;
    // then use the token it recorded, or read again.
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
  // The token is ours to supply unless the caller set the header itself.
  const suppliesToken = method !== "GET" && method !== "HEAD" && !merged.has(csrfHeader)
  // A rejected token means the write never ran, so one retry with a fresh
  // token is safe; a streamed body can't be sent twice.
  let mayRetry = suppliesToken && !(init.body instanceof ReadableStream)

  // Timeouts, dropped connections and caller cancellation can strike while
  // the body is still arriving, so they are handled for the body read too.
  const transportFailure = (error: unknown): never => {
    if (signal?.aborted) throw error
    if (timeout?.aborted) throw new ApiError("timeout", `Haxy did not answer within ${Math.round((limit ?? 0) / 1000)} seconds.`, 0)
    throw new ApiError("unreachable", "Haxy Hub could not be reached.", 0)
  }

  for (;;) {
    if (suppliesToken) merged.set(csrfHeader, await tokenForWrite(signal))
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
    if (envelope?.code === "csrf" && mayRetry) {
      mayRetry = false
      forgetCsrfToken(merged.get(csrfHeader))
      continue
    }
    if (envelope) throw new ApiError(envelope.code, envelope.message, response.status, envelope.field_errors)
    if (proxyFailureStatuses.has(response.status)) {
      throw new ApiError("unreachable", "Haxy Hub could not connect to the Haxy backend.", response.status)
    }
    throw new ApiError("invalid_response", `Haxy returned HTTP ${response.status} without an error description.`, response.status)
  }
}

export function getJson<T>(path: string, options: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
  return requestJson<T>(path, { ...options, method: "GET" })
}
