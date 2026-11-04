/**
 * The viewer's own account: registration, email, password, SSH keys and
 * deletion. Server mode only; local mode answers `unsupported`. Every route
 * acts on the session's viewer, never on a named user. Mirrors haxy's
 * src/api/account.zig.
 */
import { ApiError, getJson, requestJson, type Page, type RequestOptions } from "@/lib/api"
import { fetchSession, rotate, type Session, type Viewer } from "@/lib/session"

export const accountPath = "/api/v1/account"

/** The logged-in viewer's account. */
export type Account = { name: string; email: string }

export type Registration = { name: string; email: string; password: string; password_again: string }

type Options = Pick<RequestOptions, "signal">

/**
 * The header naming the account a change is for. The session cookie is shared
 * by every tab, so another tab may sign in as someone else after a form was
 * loaded (and the CSRF token, bound to the browser, can't tell); Haxy refuses
 * a change whose named viewer isn't the session's, so it never lands on the
 * wrong account, even when the client retries after a CSRF refusal.
 */
export const viewerHeader = "X-Haxy-Viewer"

/** A change was refused because someone other than `expected` is signed in now. */
export class ViewerChangedError extends ApiError {
  readonly viewer: Viewer | null

  constructor(expected: string, viewer: Viewer | null) {
    super("conflict", viewer
      ? `You're signed in as ${viewer.name} now (perhaps from another tab), so this change to ${expected}'s account wasn't made. Reload to continue as ${viewer.name}.`
      : `You're signed out now (perhaps from another tab), so this change to ${expected}'s account wasn't made. Reload to continue.`, 409)
    this.name = "ViewerChangedError"
    this.viewer = viewer
  }
}

const json = (body: unknown, viewer?: string): RequestOptions => ({
  headers: { "Content-Type": "application/json", ...(viewer !== undefined ? { [viewerHeader]: viewer } : {}) },
  body: JSON.stringify(body),
})

/**
 * Runs a change to `viewer`'s account. When Haxy refuses it as being for
 * someone else (`conflict` without field errors) or unauthenticated, the
 * session is read to say who is signed in now.
 */
async function asViewer<T>(viewer: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const maybeSwitched = error instanceof ApiError &&
      (error.code === "unauthenticated" || (error.code === "conflict" && Object.keys(error.fieldErrors).length === 0))
    if (!maybeSwitched) throw error
    let current: Viewer | null
    try {
      current = (await fetchSession()).viewer
    } catch {
      throw error
    }
    if (current?.name !== viewer) throw new ViewerChangedError(viewer, current)
    throw error
  }
}

/** The viewer's account; `unauthenticated` when nobody is logged in. */
export function getAccount(options: Options = {}): Promise<Account> {
  return getJson<Account>(accountPath, options)
}

/**
 * Creates an account and logs this browser in as it. Rejects with
 * `validation` or `conflict` (with field errors keyed by Registration's
 * fields), or `forbidden` when someone is already logged in.
 */
export function register(registration: Registration): Promise<Session> {
  return rotate(() => requestJson<unknown>(accountPath, { method: "POST", ...json(registration) }))
}

/**
 * Changes `viewer`'s email (the account the form was loaded for); rejects with
 * `validation` or `conflict` keyed by `email`, or ViewerChangedError.
 */
export function changeEmail(viewer: string, email: string): Promise<Account> {
  return asViewer(viewer, () => requestJson<Account>(`${accountPath}/email`, { method: "PUT", ...json({ email }, viewer) }))
}

export type PasswordChange = { current_password: string; new_password: string; new_password_again: string }

/** Changes the viewer's password; rejects with `validation` keyed by PasswordChange's fields. */
export function changePassword(viewer: string, change: PasswordChange): Promise<Account> {
  return asViewer(viewer, () => requestJson<Account>(`${accountPath}/password`, { method: "PUT", ...json(change, viewer) }))
}

/** One of the viewer's SSH keys. Public keys aren't secret; `key` is the whole authorized_keys line. */
export type SshKey = {
  /** SHA256, as `ssh-keygen -l` prints it; identifies the key. */
  fingerprint: string
  type: string
  /** Null when the key has no comment. */
  comment: string | null
  key: string
}

/** The viewer's SSH keys, in the order they were added. Never more than one page. */
export function listKeys(options: Options = {}): Promise<Page<SshKey>> {
  return getJson<Page<SshKey>>(`${accountPath}/keys`, options)
}

/** Adds an OpenSSH public key line; rejects with `validation` or `conflict` keyed by `key`. */
export function addKey(viewer: string, key: string): Promise<SshKey> {
  return asViewer(viewer, () => requestJson<SshKey>(`${accountPath}/keys`, { method: "POST", ...json({ key }, viewer) }))
}

/** Removes the key with this fingerprint and returns the keys that remain; `not_found` if the viewer has none. */
export function removeKey(viewer: string, fingerprint: string): Promise<Page<SshKey>> {
  return asViewer(viewer, () => requestJson<Page<SshKey>>(`${accountPath}/keys/${encodeURIComponent(fingerprint)}`, {
    method: "DELETE",
    headers: { [viewerHeader]: viewer },
  }))
}

export type Deletion = { confirm: string; password: string }

/**
 * Permanently deletes the viewer's account — and every repository and fork
 * it owns — then logs this browser out. Rejects with `validation` keyed by
 * `confirm` (the account name, typed) or `password`.
 */
export function deleteAccount(viewer: string, deletion: Deletion): Promise<Session> {
  return asViewer(viewer, () => rotate(() => requestJson<unknown>(accountPath, { method: "DELETE", ...json(deletion, viewer) })))
}
