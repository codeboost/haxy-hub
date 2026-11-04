import { createHash, randomBytes } from "node:crypto"
import type { Page } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// Account management in the browser — registration, email, password, SSH keys
// and account deletion — through Vite's proxy against a real `haxy serve`.
// Every mutation is checked again after a refresh and, where it matters, a
// backend restart.

const header = (page: Page) => page.getByRole("banner")

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }

async function logIn(page: Page, hubUrl: string, username: string, password: string) {
  await page.goto(`${hubUrl}/login?next=%2Faccount`)
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${username}`)
}

test("a visitor registers, is signed in, and the account survives a backend restart", async ({ page, launch }) => {
  let backend = await launch.server()
  const hub = await launch.hub(backend.port)

  await page.goto(hub.url)
  await header(page).getByRole("link", { name: "Register" }).click()
  await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible()
  await page.getByLabel("Username").fill("carol")
  await page.getByLabel("Email").fill("carol@example.test")
  await page.getByLabel("Password", { exact: true }).fill("a long password")
  await page.getByLabel("Confirm password").fill("a long password")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(header(page)).toContainText("Signed in as carol")
  await expect(page).toHaveURL(`${hub.url}/account`)
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("carol@example.test")

  backend = await backend.restart!()
  await page.reload()
  await expect(header(page)).toContainText("Signed in as carol")
  await header(page).getByRole("button", { name: "Log out" }).click()
  await logIn(page, hub.url, "carol", "a long password")
})

test("registration failures appear beside the field and keep the name and email but not the passwords", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/register`)
  const form = {
    name: page.getByLabel("Username"),
    email: page.getByRole("textbox", { name: "Email" }),
    password: page.getByLabel("Password", { exact: true }),
    again: page.getByLabel("Confirm password"),
  }
  // a taken name
  await form.name.fill(alice.name)
  await form.email.fill("someone@example.test")
  await form.password.fill("pw one")
  await form.again.fill("pw one")
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(form.name).toHaveAccessibleDescription("That username is taken.")
  await expect(form.name).toHaveValue(alice.name)
  await expect(form.email).toHaveValue("someone@example.test")
  await expect(form.password).toHaveValue("")
  await expect(form.again).toHaveValue("")

  // mismatched passwords
  await form.name.fill("dave")
  await form.password.fill("pw one")
  await form.again.fill("pw two")
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(form.again).toHaveAccessibleDescription("The passwords don't match.")
  await expect(form.name).not.toHaveAttribute("aria-invalid")

  // an invalid name
  await form.name.fill("x")
  await form.password.fill("pw one")
  await form.again.fill("pw one")
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(form.name).toHaveAccessibleDescription(/letters, digits and single hyphens/)

  // nothing was created: the page is still the form, and after a refresh too
  await page.reload()
  await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()
})

test("a user changes their email, which persists across a refresh and a backend restart", async ({ page, launch }) => {
  let backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  const email = page.getByRole("textbox", { name: "Email" })
  await expect(email).toHaveValue(alice.email)
  // another account's email is refused beside the field, keeping the input
  await email.fill(bob.email)
  await page.getByRole("button", { name: "Save email" }).click()
  await expect(email).toHaveAccessibleDescription("Another account already uses that email address.")
  await expect(email).toHaveValue(bob.email)
  // and so is an empty one
  await email.fill("")
  await page.getByRole("button", { name: "Save email" }).click()
  await expect(email).toHaveAccessibleDescription("Enter an email address.")

  await email.fill("alice@new.example.test")
  await page.getByRole("button", { name: "Save email" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Email saved." })).toBeVisible()
  await expect(email).not.toHaveAttribute("aria-invalid")

  await page.reload()
  await expect(email).toHaveValue("alice@new.example.test")
  backend = await backend.restart!()
  await page.reload()
  await expect(email).toHaveValue("alice@new.example.test")
})

test("a user changes their password after the current-password and confirmation checks", async ({ page, launch }) => {
  let backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  const current = page.getByLabel("Current password")
  const next = page.getByLabel("New password", { exact: true })
  const again = page.getByLabel("Confirm new password")
  const save = page.getByRole("button", { name: "Change password" })

  // nothing filled in
  await save.click()
  await expect(current).toHaveAccessibleDescription("Enter your current password.")
  // a wrong current password; no password is kept after a failure
  await current.fill("not it")
  await next.fill("brand new password")
  await again.fill("brand new password")
  await save.click()
  await expect(current).toHaveAccessibleDescription("Your current password is incorrect.")
  await expect(current).toHaveValue("")
  await expect(next).toHaveValue("")
  await expect(again).toHaveValue("")
  // a mismatched confirmation
  await current.fill(alice.password)
  await next.fill("brand new password")
  await again.fill("brand new passwort")
  await save.click()
  await expect(again).toHaveAccessibleDescription("The new passwords don't match.")

  await current.fill(alice.password)
  await next.fill("brand new password")
  await again.fill("brand new password")
  await save.click()
  await expect(page.getByRole("status").filter({ hasText: "Password changed." })).toBeVisible()
  await expect(current).toHaveValue("")

  // the new password, not the old one, logs in after a restart
  backend = await backend.restart!()
  await page.reload()
  await header(page).getByRole("button", { name: "Log out" }).click()
  await page.goto(`${hub.url}/login`)
  await page.getByLabel("Username").fill(alice.name)
  await page.getByLabel("Password").fill(alice.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByRole("alert")).toContainText("Incorrect username or password.")
  await logIn(page, hub.url, alice.name, "brand new password")
})

// An OpenSSH public key line with a well-formed (random) ed25519 blob, and the
// SHA256 fingerprint ssh-keygen -l prints for it.
function sshKey(type = "ssh-ed25519", comment = ""): { line: string; fingerprint: string } {
  const field = (bytes: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes])
  const blob = Buffer.concat([field(Buffer.from(type)), field(randomBytes(32))])
  const line = `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`
  return { line, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` }
}

test("a user adds SSH keys, sees their fingerprints, and removes one after confirming", async ({ page, launch }) => {
  let backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  const keys = page.getByRole("list", { name: "SSH keys" })
  const input = page.getByLabel("Public key")
  const add = page.getByRole("button", { name: "Add key" })
  await expect(page.getByText("You have no SSH keys.")).toBeVisible()

  const laptop = sshKey("ssh-ed25519", "alice@laptop")
  const desktop = sshKey("ssh-ed25519")
  await input.fill(laptop.line)
  await add.click()
  await expect(keys.getByRole("listitem")).toHaveCount(1)
  await expect(input).toHaveValue("")
  await input.fill(desktop.line)
  await add.click()
  await expect(keys.getByRole("listitem")).toHaveCount(2)
  await expect(keys.getByRole("listitem").filter({ hasText: "alice@laptop" })).toContainText(laptop.fingerprint)
  // a key without a comment is labelled by its type
  await expect(keys.getByRole("listitem").filter({ hasText: desktop.fingerprint })).toContainText("ssh-ed25519")

  backend = await backend.restart!()
  await page.reload()
  await expect(keys.getByRole("listitem")).toHaveCount(2)

  // cancelling a removal keeps the key; confirming removes it
  const laptopRow = keys.getByRole("listitem").filter({ hasText: laptop.fingerprint })
  await laptopRow.getByRole("button", { name: "Remove alice@laptop" }).click()
  await expect(laptopRow).toContainText("Remove this key? Git over SSH with it stops working.")
  await laptopRow.getByRole("button", { name: "Cancel" }).click()
  await expect(keys.getByRole("listitem")).toHaveCount(2)
  await laptopRow.getByRole("button", { name: "Remove alice@laptop" }).click()
  await laptopRow.getByRole("button", { name: "Remove key" }).click()
  await expect(keys.getByRole("listitem")).toHaveCount(1)
  await expect(keys).not.toContainText(laptop.fingerprint)

  await page.reload()
  await expect(keys.getByRole("listitem")).toHaveCount(1)
  await expect(keys).toContainText(desktop.fingerprint)
})

test("duplicate, invalid, unsupported and over-limit SSH keys are refused beside the field", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)

  const input = page.getByLabel("Public key")
  const add = page.getByRole("button", { name: "Add key" })
  const key = sshKey("ssh-ed25519", "first")
  await input.fill(key.line)
  await add.click()
  await expect(page.getByRole("list", { name: "SSH keys" }).getByRole("listitem")).toHaveCount(1)

  await input.fill(key.line)
  await add.click()
  await expect(input).toHaveAccessibleDescription(/already added this key/)
  // the rejected key stays in the field to correct
  await expect(input).toHaveValue(key.line)

  await input.fill("ssh-ed25519 not-base64!")
  await add.click()
  await expect(input).toHaveAccessibleDescription(/OpenSSH public key/)

  await input.fill(sshKey("ecdsa-sha2-nistp521").line)
  await add.click()
  await expect(input).toHaveAccessibleDescription(/ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256 and ecdsa-sha2-nistp384/)

  // fill up to the limit through the API as the same browser, then one more
  const headers = { ...(await writeHeaders(page.request, hub.url)), "Content-Type": "application/json", "X-Haxy-Viewer": alice.name }
  for (let i = 1; i < 50; i++) {
    const response = await page.request.post(`${hub.url}/api/v1/account/keys`, { headers, data: { key: sshKey().line } })
    expect(response.status()).toBe(201)
  }
  await page.reload()
  await expect(page.getByRole("list", { name: "SSH keys" }).getByRole("listitem")).toHaveCount(50)
  await input.fill(sshKey().line)
  await add.click()
  await expect(input).toHaveAccessibleDescription(/at most 50 SSH keys/)
  await page.reload()
  await expect(page.getByRole("list", { name: "SSH keys" }).getByRole("listitem")).toHaveCount(50)
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("deleting an account needs the typed name and password, then removes the user and their repositories", async ({ page, launch }) => {
    let backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await logIn(page, hub.url, "bobby", "password")

    const danger = page.getByRole("region", { name: "Delete account" })
    await expect(danger).toContainText("every repository and fork you own")
    const confirm = danger.getByLabel("Type bobby to confirm")
    const password = danger.getByLabel("Password")
    const remove = danger.getByRole("button", { name: "Permanently delete this account" })

    // the typed name must match exactly; it is kept, the password is not
    await confirm.fill("bob")
    await password.fill("password")
    await remove.click()
    await expect(confirm).toHaveAccessibleDescription(/Type bobby exactly/)
    await expect(confirm).toHaveValue("bob")
    await expect(password).toHaveValue("")

    await confirm.fill("bobby")
    await password.fill("not the password")
    await remove.click()
    await expect(password).toHaveAccessibleDescription("Incorrect password.")
    await expect(confirm).toHaveValue("bobby")

    // nothing was deleted so far
    await page.goto(`${hub.url}/users/bobby`)
    await expect(page.getByRole("list", { name: "Repositories" })).toContainText("linux")

    await page.goto(`${hub.url}/account`)
    await confirm.fill("bobby")
    await password.fill("password")
    await remove.click()
    await expect(page).toHaveURL(`${hub.url}/`)
    await expect(header(page).getByRole("link", { name: "Log in" })).toBeVisible()

    // the user and their repositories are gone, after a restart too
    backend = await backend.restart!()
    await page.goto(`${hub.url}/users/bobby`)
    await expect(page.getByRole("heading", { name: "User not found" })).toBeVisible()
    const repos = await page.request.get(`${hub.url}/api/v1/users/bobby/repos`)
    expect(repos.status()).toBe(404)

    // and the account can't log in
    await page.goto(`${hub.url}/login`)
    await page.getByLabel("Username").fill("bobby")
    await page.getByLabel("Password").fill("password")
    await page.getByRole("button", { name: "Log in" }).click()
    await expect(page.getByRole("alert")).toContainText("Incorrect username or password.")
  })
})

test("local mode shows the account features as unavailable", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  await page.goto(hub.url)
  await expect(header(page)).toContainText("Local mode")
  await expect(header(page).getByRole("link", { name: "Register" })).toHaveCount(0)

  for (const path of ["/register", "/account"]) {
    await page.goto(`${hub.url}${path}`)
    await expect(page.getByRole("status").filter({ hasText: "without accounts" })).toBeVisible()
    await expect(page.getByRole("button")).toHaveCount(0)
    await expect(page.getByRole("textbox")).toHaveCount(0)
  }
})

test("an account form loaded for one user never changes another who signed in from another tab", async ({ page, context, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue(alice.email)

  // another tab of the same browser (sharing its cookies) logs out and signs
  // in as bob through Haxy Hub, which also rotates the CSRF token alice's tab holds
  const other = await context.newPage()
  await other.goto(hub.url)
  await header(other).getByRole("button", { name: "Log out" }).click()
  await expect(header(other).getByRole("link", { name: "Log in" })).toBeVisible()
  await logIn(other, hub.url, bob.name, bob.password)

  const email = page.getByRole("textbox", { name: "Email" })
  await email.fill("hijacked@example.test")
  await page.getByRole("button", { name: "Save email" }).click()
  await expect(page.getByRole("alert")).toContainText(`signed in as ${bob.name}`)
  await page.getByLabel("Public key").fill(sshKey().line)
  await page.getByRole("button", { name: "Add key" }).click()
  await expect(page.getByRole("region", { name: "SSH keys" }).getByRole("alert")).toContainText(`signed in as ${bob.name}`)

  // and through Haxy's own login form, which rotates the token too (#30)
  await header(other).getByRole("button", { name: "Log out" }).click()
  await expect(header(other).getByRole("link", { name: "Log in" })).toBeVisible()
  await logIn(other, hub.url, alice.name, alice.password)
  await page.reload()
  await expect(email).toHaveValue(alice.email)
  const login = await page.request.post(`${backend.origin}/login`, { form: { username: bob.name, password: bob.password }, maxRedirects: 0 })
  expect(login.status()).toBe(303)
  await email.fill("hijacked@example.test")
  await page.getByRole("button", { name: "Save email" }).click()
  await expect(page.getByRole("alert")).toContainText(`signed in as ${bob.name}`)

  // bob's account is untouched, and so is alice's
  await other.goto(`${hub.url}/account`)
  await expect(header(other)).toContainText(`Signed in as ${bob.name}`)
  await expect(other.getByRole("textbox", { name: "Email" })).toHaveValue(bob.email)
  await expect(other.getByText("You have no SSH keys.")).toBeVisible()

  // reloading shows who is signed in now
  await page.getByRole("button", { name: "Reload" }).first().click()
  await expect(header(page)).toContainText(`Signed in as ${bob.name}`)
  await expect(email).toHaveValue(bob.email)
})

test("a key removal whose answer is lost reloads the keys instead of offering the removal again", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  const keys = page.getByRole("list", { name: "SSH keys" })
  for (const comment of ["one", "two", "three"]) {
    await page.getByLabel("Public key").fill(sshKey("ssh-ed25519", comment).line)
    await page.getByRole("button", { name: "Add key" }).click()
    await expect(keys.getByRole("listitem").filter({ hasText: comment })).toBeVisible()
  }

  // the backend removes the key, but the answer never reaches the browser
  await page.route("**/api/v1/account/keys/*", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })
  await keys.getByRole("button", { name: "Remove one" }).click()
  await keys.getByRole("button", { name: "Remove key" }).click()
  await expect(page.getByRole("region", { name: "SSH keys" }).getByText(/may or may not have been removed/)).toBeVisible()
  await expect(keys.getByRole("listitem")).toHaveCount(2)
  await page.unroute("**/api/v1/account/keys/*")

  // a key already removed elsewhere is not found: the list reloads without it
  const removed = await page.request.delete(`${hub.url}/api/v1/account/keys/${encodeURIComponent(await keys.getByRole("listitem").filter({ hasText: "two" }).locator(".font-mono").innerText())}`, {
    headers: { ...(await writeHeaders(page.request, hub.url)), "X-Haxy-Viewer": alice.name },
  })
  expect(removed.status()).toBe(200)
  await keys.getByRole("button", { name: "Remove two" }).click()
  await keys.getByRole("button", { name: "Remove key" }).click()
  await expect(keys.getByRole("listitem")).toHaveCount(1)
  await expect(keys).toContainText("three")
})

const internalError = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy couldn't complete this request. Try again later." } }) }

test("a registration that fails inside Haxy is reported as possibly done, not as a plain failure", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/register`)

  // the account is created, then Haxy fails (e.g. storing the session), so
  // the browser isn't signed in
  await page.route("**/api/v1/account", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await route.fetch()
    await page.context().clearCookies({ name: "haxy_session" })
    await route.fulfill(internalError)
  })
  await page.getByLabel("Username").fill("carol")
  await page.getByRole("textbox", { name: "Email" }).fill("carol@example.test")
  await page.getByLabel("Password", { exact: true }).fill("a long password")
  await page.getByLabel("Confirm password").fill("a long password")
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(page.getByRole("alert")).toContainText("may have been created")
  await expect(page.getByRole("alert").getByRole("link", { name: "Log in" })).toBeVisible()
  await page.unroute("**/api/v1/account")

  // it was: logging in works
  await logIn(page, hub.url, "carol", "a long password")
})

test("an email change with an unreadable or internal-error answer shows the stored email and says it may have saved", async ({ page, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  await logIn(page, hub.url, alice.name, alice.password)
  const email = page.getByRole("textbox", { name: "Email" })

  for (const [answer, address] of [
    [internalError, "alice@one.example.test"],
    [{ status: 200, contentType: "text/html", body: "<html>proxy page</html>" }, "alice@two.example.test"],
  ] as const) {
    // the backend stores `address` (not what was typed), then the answer is lost
    await page.route("**/api/v1/account/email", async (route) => {
      await route.fetch({ postData: JSON.stringify({ email: address }) })
      await route.fulfill(answer)
    })
    await email.fill("typed@example.test")
    await page.getByRole("button", { name: "Save email" }).click()
    await expect(page.getByRole("region", { name: "Email address" }).getByRole("alert")).toContainText("may or may not")
    // the authoritative email is read back: the change did land
    await expect(email).toHaveValue(address)
    await page.unroute("**/api/v1/account/email")
  }
  await page.reload()
  await expect(email).toHaveValue("alice@two.example.test")
})
