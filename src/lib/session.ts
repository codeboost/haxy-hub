/**
 * The viewer's session: GET /api/v1/session reads it, POST logs in, DELETE
 * logs out. The session itself is Haxy's HttpOnly cookie; this module only
 * sees who the viewer is and the CSRF token for writes.
 */
import { ApiError, beginCsrfRotation, csrfTokenReader, endCsrfRotation, getJson, requestJson, sessionPath } from "@/lib/api"

export type Viewer = { name: string }

export type Session = {
  /** Null when nobody is logged in, and always in local mode. */
  viewer: Viewer | null
  csrf_token: string
}

function readSession(body: unknown): Session {
  if (typeof body === "object" && body !== null && "csrf_token" in body && typeof body.csrf_token === "string" && "viewer" in body) {
    const { viewer } = body
    if (viewer === null) return { viewer: null, csrf_token: body.csrf_token }
    if (typeof viewer === "object" && "name" in viewer && typeof viewer.name === "string") {
      return { viewer: { name: viewer.name }, csrf_token: body.csrf_token }
    }
  }
  throw new ApiError("invalid_response", "Haxy returned a session this app could not read.", 200)
}

/**
 * Reads the session. A read that overlaps a login or logout may describe the
 * state before it, so its CSRF token is only recorded when none did.
 */
export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const record = csrfTokenReader()
  const session = readSession(await getJson<unknown>(sessionPath, { signal }))
  record(session.csrf_token)
  return session
}

/**
 * Runs a request that logs in or out (login, logout, registration, account
 * deletion), which rotates the CSRF token; its answer — a session body — is
 * authoritative.
 */
export async function rotate(change: () => Promise<unknown>): Promise<Session> {
  beginCsrfRotation()
  let session: Session
  try {
    session = readSession(await change())
  } catch (error) {
    // The backend may or may not have rotated the token: read it again next time.
    endCsrfRotation(null)
    throw error
  }
  endCsrfRotation(session.csrf_token)
  return session
}

/** Rejects with `unauthenticated` for wrong credentials, `validation` (with field errors) for missing ones. */
export function logIn(username: string, password: string): Promise<Session> {
  return rotate(() => requestJson<unknown>(sessionPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }))
}

/** Revokes the session on the server and clears its cookie. */
export function logOut(): Promise<Session> {
  return rotate(() => requestJson<unknown>(sessionPath, { method: "DELETE" }))
}

/**
 * Where to go after logging in: `next` when it is a path in this app,
 * otherwise home. Never another origin, and never the login page itself.
 */
export function returnPath(next: string | null): string {
  if (!next || !next.startsWith("/")) return "/"
  const url = new URL(next, "http://haxy.invalid")
  // Checked after normalisation: dot segments and backslashes can turn an
  // innocent-looking path into a protocol-relative one ("/.//host" is "//host").
  const path = url.pathname
  if (url.origin !== "http://haxy.invalid" || path.startsWith("//") || path.includes("\\") || path === "/login") return "/"
  return path + url.search + url.hash
}

/** The login route, remembering `from` (a path with its query) to return to. */
export function loginPath(from: string): string {
  return `/login?next=${encodeURIComponent(returnPath(from))}`
}
