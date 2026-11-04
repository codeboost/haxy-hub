/**
 * The viewer's own account: registration, email, password, SSH keys and
 * deletion. Server mode only; local mode answers `unsupported`. Every route
 * acts on the session's viewer, never on a named user. Mirrors haxy's
 * src/api/account.zig.
 *
 * Each change names the viewer its form was loaded for; when someone else is
 * signed in now (say, from another tab), it is refused with a
 * ViewerChangedError (see requestJson in src/lib/api.ts) and changes nothing.
 */
import { anyViewer, getJson, requestJson, type Page, type RequestOptions } from "@/lib/api"
import { rotate, type Session } from "@/lib/session"

export const accountPath = "/api/v1/account"

/** The logged-in viewer's account. */
export type Account = { name: string; email: string }

export type Registration = { name: string; email: string; password: string; password_again: string }

type Options = Pick<RequestOptions, "signal">

const json = (body: unknown): Pick<RequestOptions, "headers" | "body"> => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

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
  return rotate(() => requestJson<unknown>(accountPath, { method: "POST", ...json(registration), viewer: anyViewer }))
}

/**
 * Changes `viewer`'s email (the account the form was loaded for); rejects with
 * `validation` or `conflict` keyed by `email`, or ViewerChangedError.
 */
export function changeEmail(viewer: string, email: string): Promise<Account> {
  return requestJson<Account>(`${accountPath}/email`, { method: "PUT", ...json({ email }), viewer })
}

export type PasswordChange = { current_password: string; new_password: string; new_password_again: string }

/** Changes the viewer's password; rejects with `validation` keyed by PasswordChange's fields. */
export function changePassword(viewer: string, change: PasswordChange): Promise<Account> {
  return requestJson<Account>(`${accountPath}/password`, { method: "PUT", ...json(change), viewer })
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
  return requestJson<SshKey>(`${accountPath}/keys`, { method: "POST", ...json({ key }), viewer })
}

/** Removes the key with this fingerprint and returns the keys that remain; `not_found` if the viewer has none. */
export function removeKey(viewer: string, fingerprint: string): Promise<Page<SshKey>> {
  return requestJson<Page<SshKey>>(`${accountPath}/keys/${encodeURIComponent(fingerprint)}`, { method: "DELETE", viewer })
}

export type Deletion = { confirm: string; password: string }

/**
 * Permanently deletes the viewer's account — and every repository and fork
 * it owns — then logs this browser out. Rejects with `validation` keyed by
 * `confirm` (the account name, typed) or `password`.
 */
export function deleteAccount(viewer: string, deletion: Deletion): Promise<Session> {
  return rotate(() => requestJson<unknown>(accountPath, { method: "DELETE", ...json(deletion), viewer }))
}
