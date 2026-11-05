import type { APIRequestContext, Page, PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { expect, test, type Launch } from "./support/fixtures"
import { createIssue } from "./support/issues"
import { pushRepo } from "./support/push"
import { createRepo, signedIn } from "./support/repos"
import { sshUser } from "./support/ssh"

// Administering a repository in the browser — its settings, members,
// branches and deletion — through Vite's proxy against a real `haxy serve`.
// Every change is checked again after a refresh, and where it matters after a
// backend restart and from another user's next request.

const header = (page: Page) => page.getByRole("banner")
const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const internalError = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy couldn't complete this request. Try again later." } }) }

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** A server with alice and bob, alice's repository `tools`, and the hub in front. */
async function setUp(launch: Launch, playwright: PlaywrightWorkerArgs["playwright"], access: "public" | "private", options: { ssh?: boolean } = {}) {
  const backend = await launch.server({ ssh: options.ssh })
  for (const account of [alice, bob]) await registerUser(backend, account)
  const hub = await launch.hub(backend.port)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tools", description: "Handy scripts", access })
  return { backend, hub, owner, repoPage: `${hub.url}/repos/${alice.name}/tools`, api: `${hub.url}/api/v1/repos/${alice.name}/tools` }
}

/** Haxy's answer to `context` for the repository's overview. */
const overviewStatus = async (context: APIRequestContext, api: string) => (await context.get(api)).status()

const sections = (page: Page) => page.getByRole("navigation", { name: "Repository sections" })
const settingsPages = (page: Page) => page.getByRole("navigation", { name: "Settings pages" })

/** Adds `name` as a member through the API, as `owner`. */
async function grant(owner: APIRequestContext, hubUrl: string, api: string, name: string, role: "member" | "owner" = "member") {
  const headers = { ...(await writeHeaders(owner, hubUrl)), "Content-Type": "application/json" }
  expect((await owner.post(`${api}/settings/members`, { headers, data: { name } })).status()).toBe(201)
  if (role === "owner") expect((await owner.put(`${api}/settings/members/${name}`, { headers, data: { role } })).status()).toBe(200)
}

test("an owner changes the settings in the browser; other users' next reads follow, and it survives a restart", async ({ page, launch, playwright, request }) => {
  let { backend, hub, repoPage, api } = await setUp(launch, playwright, "public")
  const other = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  expect(await overviewStatus(other, api)).toBe(200)

  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools`)
  await sections(page).getByRole("link", { name: "Settings" }).click()
  await expect(page).toHaveURL(`${repoPage}/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  await expect(form.getByLabel("Hash format")).toHaveText("SHA-1")
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Handy scripts")
  await expect(form.getByRole("group", { name: "Visibility" }).getByRole("radio", { name: /Public/ })).toBeChecked()

  await form.getByRole("textbox", { name: "Description" }).fill("Kept to ourselves")
  await form.getByRole("group", { name: "Visibility" }).getByRole("radio", { name: /Private/ }).check()
  await form.getByRole("group", { name: "Who can open issues" }).getByRole("radio", { name: /Nobody/ }).check()
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("status")).toHaveText("Settings saved.")
  // the header follows: private, and issues are gone
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Private")
  await expect(page.getByText("Kept to ourselves").first()).toBeVisible()
  await expect(sections(page).getByText("Issues")).toHaveCount(0)

  // the very next reads by anyone else find nothing
  expect(await overviewStatus(other, api)).toBe(404)
  expect(await overviewStatus(request, api)).toBe(404)

  backend = await backend.restart!()
  await page.reload()
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Kept to ourselves")
  await expect(form.getByRole("group", { name: "Visibility" }).getByRole("radio", { name: /Private/ })).toBeChecked()
  await expect(form.getByRole("group", { name: "Who can open issues" }).getByRole("radio", { name: /Nobody/ })).toBeChecked()
  await expect(form.getByRole("group", { name: "Who can start discussions" }).getByRole("radio", { name: /Anybody/ })).toBeChecked()
  await other.dispose()
})

test("only owners see the settings; others are told why, and local mode has none", async ({ page, launch, playwright }) => {
  const { hub, repoPage } = await setUp(launch, playwright, "public")
  await page.goto(repoPage)
  await expect(sections(page).getByRole("link", { name: "Files" })).toBeVisible()
  await expect(sections(page).getByText("Settings")).toHaveCount(0)
  await page.goto(`${repoPage}/settings`)
  await expect(page.getByText("to manage this repository")).toBeVisible()
  await expect(page.getByRole("link", { name: "Log in" }).last()).toHaveAttribute("href", `/login?next=${encodeURIComponent(`/repos/${alice.name}/tools/settings`)}`)

  await logIn(page, hub.url, bob, `/repos/${alice.name}/tools`)
  await expect(sections(page).getByRole("link", { name: "Files" })).toBeVisible()
  await expect(sections(page).getByText("Settings")).toHaveCount(0)
  await page.goto(`${repoPage}/settings/members`)
  await expect(page.getByText("Only the repository's owners can manage it.")).toBeVisible()
  await expect(settingsPages(page)).toHaveCount(0)

  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  await page.goto(`${localHub.url}/repo`)
  await expect(sections(page).getByText("Settings")).toHaveCount(0)
  await page.goto(`${localHub.url}/repo/settings`)
  await expect(page.getByText("Local mode has no accounts or members")).toBeVisible()
})

test("an owner adds, promotes, demotes and removes members, confirming what takes access away; a removed member's next write is refused", async ({ page, launch, playwright }) => {
  let { backend, hub, repoPage } = await setUp(launch, playwright, "private")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members`)
  const members = page.getByRole("list", { name: "Members" })
  await expect(members.getByRole("listitem").first()).toContainText(`${alice.name}Main owner`)
  await expect(page.getByText("No one else is a member yet.")).toBeVisible()

  const add = page.getByRole("form", { name: "Add a member" })
  await add.getByLabel("Add a member").fill("nobody-here")
  await add.getByRole("button", { name: "Add member" }).click()
  await expect(add.getByText("No user has that name.")).toBeVisible()
  await expect(add.getByLabel("Add a member")).toHaveValue("nobody-here")
  await add.getByLabel("Add a member").fill(bob.name)
  await add.getByRole("button", { name: "Add member" }).click()
  await expect(add.getByRole("status")).toHaveText(`${bob.name} is a member now.`)
  const bobRow = members.getByRole("listitem").filter({ hasText: bob.name })
  await expect(bobRow).toContainText("Member")

  // bob writes as a member
  const memberForms = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  await createIssue(memberForms, backend, `/${alice.name}:tools`, { title: "As a member" })

  await bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` }).click()
  await expect(bobRow).toContainText("Owner")
  await page.reload()
  await expect(bobRow).toContainText("Owner")

  await bobRow.getByRole("button", { name: `Demote ${bob.name} to member` }).click()
  const demotion = bobRow.getByRole("group", { name: `Confirm: Demote to member ${bob.name}` })
  await expect(demotion).toContainText("They'll no longer manage this repository.")
  await demotion.getByRole("button", { name: "Cancel" }).click()
  await expect(bobRow).toContainText("Owner")
  await bobRow.getByRole("button", { name: `Demote ${bob.name} to member` }).click()
  await demotion.getByRole("button", { name: "Demote to member" }).click()
  await expect(bobRow).toContainText("Member")

  await bobRow.getByRole("button", { name: `Remove ${bob.name}` }).click()
  await bobRow.getByRole("group", { name: `Confirm: Remove member ${bob.name}` }).getByRole("button", { name: "Remove member" }).click()
  await expect(bobRow).toHaveCount(0)

  backend = await backend.restart!()
  await page.reload()
  await expect(page.getByText("No one else is a member yet.")).toBeVisible()
  // the private repository is hidden from bob again: his next write finds nothing
  const refused = await memberForms.post(`${backend.origin}/${alice.name}:tools/issues/new`, { form: { title: "After removal", labels: "", description: "" }, maxRedirects: 0 })
  expect(refused.status()).toBe(404)
  await page.goto(`${repoPage}/issues`)
  await expect(page.getByRole("link", { name: "As a member" })).toBeVisible()
  await expect(page.getByText("After removal")).toHaveCount(0)
  await memberForms.dispose()
})

test("a granted owner manages members but sees why only the main owner can delete, and loses the settings once demoted", async ({ page, launch, playwright }) => {
  const { hub, owner, repoPage, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name, "owner")
  await logIn(page, hub.url, bob, `/repos/${alice.name}/tools`)
  await sections(page).getByRole("link", { name: "Settings" }).click()
  await settingsPages(page).getByRole("link", { name: "Delete" }).click()
  await expect(page.getByText(`Only the main owner, ${alice.name}, can delete this repository.`)).toBeVisible()
  await expect(page.getByRole("form", { name: "Delete repository" })).toHaveCount(0)

  // alice demotes bob; his next navigation in the settings says he no longer manages it
  const headers = { ...(await writeHeaders(owner, hub.url)), "Content-Type": "application/json" }
  await owner.put(`${api}/settings/members/${bob.name}`, { headers, data: { role: "member" } })
  await settingsPages(page).getByRole("link", { name: "Members" }).click()
  await expect(page.getByText("Only the repository's owners can manage it.")).toBeVisible()
  await page.goto(repoPage)
  await expect(sections(page).getByText("Settings")).toHaveCount(0)
})

/** alice's repository `tools`, pushed over SSH with `main` and a `dev` whose README differs. */
async function pushBranches(backend: Backend, hubUrl: string, owner: APIRequestContext) {
  const git = await sshUser(backend, hubUrl, owner, alice.name)
  const work = await git.workTree("tools", "main", [{ "README.md": "# Main line\n" }, { "notes.txt": "two\n" }])
  await git.git(work, "push", "--quiet", await git.remote(alice.name, "tools"), "main")
  await git.git(work, "checkout", "--quiet", "-b", "dev")
  await (await import("node:fs/promises")).writeFile(`${work}/README.md`, "# Dev line\n")
  await git.git(work, "commit", "--quiet", "-am", "dev readme")
  await git.git(work, "push", "--quiet", await git.remote(alice.name, "tools"), "dev")
  await git.git(work, "checkout", "--quiet", "main")
  return { git, work }
}

test("an owner changes the default branch, which the landing view follows, and protects a branch against force-pushes", async ({ page, launch, playwright }) => {
  let { backend, hub, owner, repoPage } = await setUp(launch, playwright, "public", { ssh: true })
  const { git, work } = await pushBranches(backend, hub.url, owner)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools`)
  await expect(page.getByRole("heading", { name: "Main line" })).toBeVisible()

  await sections(page).getByRole("link", { name: "Settings" }).click()
  await settingsPages(page).getByRole("link", { name: "Branches" }).click()
  const defaultForm = page.getByRole("form", { name: "Default branch" })
  await expect(defaultForm.getByLabel("Default branch")).toHaveValue("branch:main")
  await defaultForm.getByLabel("Default branch").selectOption("other")
  await defaultForm.getByLabel("Branch name").fill("nothing")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(defaultForm.getByText("There is no branch by that name.")).toBeVisible()
  await defaultForm.getByLabel("Default branch").selectOption("branch:dev")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(defaultForm.getByRole("status")).toHaveText("The default branch is dev now.")

  await sections(page).getByRole("link", { name: "Files" }).click()
  await expect(page.getByRole("heading", { name: "Dev line" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Branch dev")

  await page.goto(`${repoPage}/settings/branches`)
  const protect = page.getByRole("form", { name: "Protect a branch" })
  await protect.getByLabel("Protect a branch").selectOption("branch:main")
  await protect.getByRole("button", { name: "Protect branch" }).click()
  const protectedList = page.getByRole("list", { name: "Protected branches" })
  await expect(protectedList.getByRole("listitem")).toHaveText(["mainUnprotect"])
  await protect.getByRole("button", { name: "Protect branch" }).click()
  await expect(protect.getByText("This branch is already protected.")).toBeVisible()

  backend = await backend.restart!()
  await page.reload()
  await expect(protectedList.getByRole("listitem")).toHaveText(["mainUnprotect"])
  await expect(page.getByRole("form", { name: "Default branch" }).getByLabel("Default branch")).toHaveValue("branch:dev")

  // a force-push over SSH to the protected branch is refused
  await git.git(work, "reset", "--quiet", "--hard", "HEAD~1")
  await git.git(work, "commit", "--quiet", "--allow-empty", "-m", "rewritten")
  await expect(git.git(work, "push", "--quiet", "--force", await git.remote(alice.name, "tools"), "main")).rejects.toThrow(/main/)

  await protectedList.getByRole("button", { name: "Unprotect main" }).click()
  await expect(page.getByText("No branch is protected.")).toBeVisible()
  await page.reload()
  await expect(page.getByText("No branch is protected.")).toBeVisible()
  await git.git(work, "push", "--quiet", "--force", await git.remote(alice.name, "tools"), "main")
})

test("the main owner deletes the repository after reading what goes, with the typed name and password; it stays gone after a restart", async ({ page, launch, playwright }) => {
  let { backend, hub, repoPage } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/delete`)
  const section = page.getByRole("region", { name: "Delete repository" })
  await expect(section).toContainText(`This permanently deletes ${alice.name}/tools`)
  await expect(section).toContainText("issues, discussions and patches")
  const form = page.getByRole("form", { name: "Delete repository" })

  await form.getByLabel(`Type ${alice.name}:tools to confirm`).fill("tools")
  await form.getByLabel("Password").fill(alice.password)
  await form.getByRole("button", { name: "Permanently delete this repository" }).click()
  await expect(form.getByText(`Type ${alice.name}:tools exactly to confirm.`)).toBeVisible()
  // the typed name stays; the password never does
  await expect(form.getByLabel(`Type ${alice.name}:tools to confirm`)).toHaveValue("tools")
  await expect(form.getByLabel("Password")).toHaveValue("")

  await form.getByLabel(`Type ${alice.name}:tools to confirm`).fill(`${alice.name}:tools`)
  await form.getByLabel("Password").fill("wrong")
  await form.getByRole("button", { name: "Permanently delete this repository" }).click()
  await expect(form.getByText("Incorrect password.")).toBeVisible()

  await form.getByLabel("Password").fill(alice.password)
  await form.getByRole("button", { name: "Permanently delete this repository" }).click()
  await expect(page).toHaveURL(`${hub.url}/users/${alice.name}`)
  await expect(page.getByRole("link", { name: "tools" })).toHaveCount(0)

  backend = await backend.restart!()
  await page.goto(repoPage)
  await expect(page.getByRole("heading", { name: "Repository not found" })).toBeVisible()
})

test("a member change whose answer is lost says what Haxy holds now, and a pending change can't be sent twice", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members`)
  const add = page.getByRole("form", { name: "Add a member" })

  // the add lands, but its answer is lost
  let posts = 0
  await page.route("**/api/v1/repos/*/tools/settings/members", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    posts++
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.fetch()
    await route.fulfill(internalError)
  })
  await add.getByLabel("Add a member").fill(bob.name)
  await add.getByRole("button", { name: "Add member" }).click()
  await add.getByRole("button", { name: "Add member" }).click({ force: true })
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText(`${bob.name} is a member now`)
  expect(posts).toBe(1)
  await expect(page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: bob.name })).toContainText("Member")
})

test("a deletion whose answer is lost checks whether the repository still exists before offering another attempt", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/delete`)
  const form = page.getByRole("form", { name: "Delete repository" })
  await page.route(`**/api/v1/repos/${alice.name}/tools`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    await route.fetch()
    await route.abort("connectionreset")
  })
  await form.getByLabel(`Type ${alice.name}:tools to confirm`).fill(`${alice.name}:tools`)
  await form.getByLabel("Password").fill(alice.password)
  await form.getByRole("button", { name: "Permanently delete this repository" }).click()
  await expect(form.getByRole("alert")).toContainText(`${alice.name}/tools doesn't exist now.`)
  await expect(form.getByRole("button", { name: "Permanently delete this repository" })).toHaveCount(0)
  await form.getByRole("link", { name: "Back to the owner's repositories" }).click()
  await expect(page).toHaveURL(`${hub.url}/users/${alice.name}`)
})

test("a member change refused before it applied leaves the row usable once Haxy's answer is read again", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members`)
  const bobRow = page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: bob.name })
  await expect(bobRow).toContainText("Member")

  // the promote never reaches Haxy, and its answer is an internal error (the lookup of bob's role does)
  await page.route(`**/api/v1/repos/*/tools/settings/members/${bob.name}`, (route) => route.request().method() === "GET" ? route.continue() : route.fulfill(internalError))
  await bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText(`${bob.name} is a member now`)
  await expect(bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` })).toBeEnabled()
  await expect(bobRow.getByRole("button", { name: `Remove ${bob.name}` })).toBeEnabled()

  // a demotion another owner made first: the row is read again and stays usable
  await page.unroute(`**/api/v1/repos/*/tools/settings/members/${bob.name}`)
  await bobRow.getByRole("button", { name: `Remove ${bob.name}` }).click()
  await page.route(`**/api/v1/repos/*/tools/settings/members/${bob.name}`, (route) => route.request().method() === "GET" ? route.continue() :
    route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "conflict", message: `${bob.name}'s role changed meanwhile. Reload the members and try again.` } }) }))
  await bobRow.getByRole("button", { name: "Remove member" }).click()
  await expect(page.getByRole("status").filter({ hasText: "role changed meanwhile" })).toBeVisible()
  await expect(bobRow.getByRole("button", { name: `Remove ${bob.name}` })).toBeEnabled()
  await page.unroute(`**/api/v1/repos/*/tools/settings/members/${bob.name}`)
  await bobRow.getByRole("button", { name: `Remove ${bob.name}` }).click()
  await bobRow.getByRole("button", { name: "Remove member" }).click()
  await expect(bobRow).toHaveCount(0)
})

test("a default-branch change that finishes after the user moved to another settings page leaves them there", async ({ page, launch, playwright }) => {
  const { backend, hub } = await setUp(launch, playwright, "public", { ssh: true })
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "dev", files: { "dev.txt": "dev\n" } }] })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/branches`)
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/v1/repos/*/tools/settings/branches/default", async (route) => {
    await released
    await route.continue()
  })
  const defaultForm = page.getByRole("form", { name: "Default branch" })
  await defaultForm.getByLabel("Default branch").selectOption("branch:dev")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()

  await settingsPages(page).getByRole("link", { name: "General" }).click()
  const general = page.getByRole("form", { name: "Repository settings" })
  await general.getByRole("textbox", { name: "Description" }).fill("Typed while it ran")
  const finished = page.waitForResponse("**/api/v1/repos/*/tools/settings/branches/default")
  release()
  expect((await finished).status()).toBe(200)
  await page.waitForTimeout(300)
  await expect(page).toHaveURL(`${hub.url}/repos/${alice.name}/tools/settings`)
  await expect(general.getByRole("textbox", { name: "Description" })).toHaveValue("Typed while it ran")
})

test("a protection whose answer is lost is recognised by Haxy's id for a branch with a slash", async ({ page, launch, playwright }) => {
  const { backend, hub } = await setUp(launch, playwright, "public", { ssh: true })
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "feature/test" }] })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/branches`)
  await page.route("**/api/v1/repos/*/tools/settings/branches/protected", async (route) => {
    await route.fetch()
    await route.fulfill(internalError)
  })
  const protect = page.getByRole("form", { name: "Protect a branch" })
  await protect.getByLabel("Protect a branch").selectOption("branch:feature/test")
  await protect.getByRole("button", { name: "Protect branch" }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText("feature/test is protected now")
  await expect(page.getByRole("list", { name: "Protected branches" }).getByRole("listitem")).toHaveText(["feature/testUnprotect"])
})

/** Another owner's settings change, made through the API from the settings as they are now. */
async function changeSettingsElsewhere(other: APIRequestContext, hubUrl: string, api: string, fields: Record<string, string>) {
  const current = (await (await other.get(`${api}/settings`)).json()) as Record<string, unknown>
  const headers = { ...(await writeHeaders(other, hubUrl)), "Content-Type": "application/json" }
  const body = { revision: current.revision, description: current.description, access: current.access, discuss_role: current.discuss_role, issue_role: current.issue_role, patch_role: current.patch_role, ...fields }
  expect((await other.put(`${api}/settings`, { headers, data: body })).status()).toBe(200)
}

test("a settings form shown from settings read earlier follows another owner's change, and never saves over one it didn't show", async ({ page, launch, playwright }) => {
  const { backend, hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name, "owner")
  const other = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  const visibility = form.getByRole("group", { name: "Visibility" })
  await expect(visibility.getByRole("radio", { name: /Public/ })).toBeChecked()

  // while alice looks at the members, bob makes the repository private
  await settingsPages(page).getByRole("link", { name: "Members" }).click()
  await expect(page.getByRole("form", { name: "Add a member" })).toBeVisible()
  await changeSettingsElsewhere(other, hub.url, api, { access: "private" })
  // back on General, the untouched form shows what Haxy holds now
  await settingsPages(page).getByRole("link", { name: "General" }).click()
  await expect(visibility.getByRole("radio", { name: /Private/ })).toBeChecked()
  await form.getByRole("textbox", { name: "Description" }).fill("Alice's words")
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("status")).toHaveText("Settings saved.")
  expect(await (await other.get(`${api}/settings`)).json()).toMatchObject({ access: "private", description: "Alice's words" })

  // an edit under way when bob changes the issues: saving is refused, and nothing of bob's is lost
  await form.getByRole("textbox", { name: "Description" }).fill("Alice again")
  await changeSettingsElsewhere(other, hub.url, api, { issue_role: "nobody" })
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("alert")).toContainText("Another owner changed these settings meanwhile.")
  expect(await (await other.get(`${api}/settings`)).json()).toMatchObject({ issue_role: "nobody", description: "Alice's words" })
  await form.getByRole("button", { name: "Load the current settings" }).click()
  await expect(form.getByRole("group", { name: "Who can open issues" }).getByRole("radio", { name: /Nobody/ })).toBeChecked()
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Alice's words")
  await form.getByRole("textbox", { name: "Description" }).fill("Alice again")
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("status")).toHaveText("Settings saved.")
  expect(await (await other.get(`${api}/settings`)).json()).toMatchObject({ issue_role: "nobody", description: "Alice again", access: "private" })
  await other.dispose()
})

test("branches are chosen by Haxy's ids, so a name whose display differs from its id is chosen and kept exactly", async ({ page, launch, playwright }) => {
  const { backend, hub, owner, api } = await setUp(launch, playwright, "public", { ssh: true })
  // a branch literally named "a%2Fb": its id escapes the "%", and decoding its
  // name as an id would name "a/b". (Haxy's SSH server refuses ref names that
  // aren't UTF-8, so a server repository can't be given one to test with.)
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "a%2Fb" }, { kind: "branch", name: "a/b" }] })
  const branches = async () => (await (await owner.get(`${api}/settings/branches`)).json()) as { default_branch: { id: string }; protected: Array<{ id: string }> }
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/branches`)
  const defaultForm = page.getByRole("form", { name: "Default branch" })
  await defaultForm.getByLabel("Default branch").selectOption("branch:a%252Fb")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(defaultForm.getByRole("status")).toHaveText("The default branch is a%2Fb now.")
  expect((await branches()).default_branch.id).toBe("branch:a%252Fb")

  // after a refresh, sending the unchanged form keeps the same branch
  await page.reload()
  await expect(defaultForm.getByLabel("Default branch")).toHaveValue("branch:a%252Fb")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(defaultForm.getByRole("status")).toHaveText("The default branch is a%2Fb now.")
  expect((await branches()).default_branch.id).toBe("branch:a%252Fb")

  const protect = page.getByRole("form", { name: "Protect a branch" })
  await protect.getByLabel("Protect a branch").selectOption("branch:a%252Fb")
  await protect.getByRole("button", { name: "Protect branch" }).click()
  await expect(page.getByRole("list", { name: "Protected branches" }).getByRole("listitem")).toHaveText(["a%2FbUnprotect"])
  expect((await branches()).protected.map((branch) => branch.id)).toEqual(["branch:a%252Fb"])
})

test("a lost deletion answer probed after another tab signed out says so, rather than calling a hidden repository gone", async ({ page, context, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "private")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/delete`)
  const form = page.getByRole("form", { name: "Delete repository" })
  const otherTab = await context.newPage()
  await otherTab.goto(hub.url)
  // the deletion never lands; before its answer arrives, the other tab signs out
  await page.route(`**/api/v1/repos/${alice.name}/tools`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    await otherTab.getByRole("banner").getByRole("button", { name: "Log out" }).click()
    await expect(otherTab.getByRole("banner").getByRole("link", { name: "Log in" })).toBeVisible()
    await route.fulfill(internalError)
  })
  await form.getByLabel(`Type ${alice.name}:tools to confirm`).fill(`${alice.name}:tools`)
  await form.getByLabel("Password").fill(alice.password)
  await form.getByRole("button", { name: "Permanently delete this repository" }).click()
  await expect(form.getByRole("alert")).toContainText("You're signed out now")
  await expect(form.getByRole("alert")).not.toContainText("doesn't exist now")
  await expect(form.getByRole("alert").getByRole("button", { name: "Reload" })).toBeVisible()
  // signed in again, the repository is still there
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools`)
  await expect(page.getByRole("heading", { level: 1 })).toContainText("tools")
})

test("a deletion that lands with its answer lost, probed after another tab signed out, says the outcome couldn't be checked", async ({ page, context, launch, playwright, request }) => {
  const { hub, api } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/delete`)
  const form = page.getByRole("form", { name: "Delete repository" })
  const otherTab = await context.newPage()
  await otherTab.goto(hub.url)
  // the deletion lands; before its answer arrives, the other tab signs out, and the answer is lost
  await page.route(`**/api/v1/repos/${alice.name}/tools`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue()
    await route.fetch()
    await otherTab.getByRole("banner").getByRole("button", { name: "Log out" }).click()
    await expect(otherTab.getByRole("banner").getByRole("link", { name: "Log in" })).toBeVisible()
    await route.abort("connectionreset")
  })
  await form.getByLabel(`Type ${alice.name}:tools to confirm`).fill(`${alice.name}:tools`)
  await form.getByLabel("Password").fill(alice.password)
  await form.getByRole("button", { name: "Permanently delete this repository" }).click()
  const alert = form.getByRole("alert")
  await expect(alert).toContainText("You're signed out now")
  await expect(alert).toContainText(`couldn't check whether ${alice.name}/tools was deleted`)
  await expect(alert).not.toContainText("wasn't made")
  await expect(alert).not.toContainText("still exists")
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible()
  await expect(form.getByRole("button", { name: "Permanently delete this repository" })).toBeDisabled()
  // it was in fact deleted
  expect(await overviewStatus(request, api)).toBe(404)
})

test("member recovery reads the one member it settles, however many members there are, including after a revoke", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name)
  // 1,100 members added after bob, so bob is listed past the first thousand
  const others = Array.from({ length: 1100 }, (_, index) => ({ name: `member-${String(index).padStart(4, "0")}`, role: "member" }))
  // reads of the list other than the page shown
  let otherPages = 0
  await page.route((url) => url.pathname.endsWith("/tools/settings/members"), async (route) => {
    if (route.request().method() !== "GET") return route.continue()
    // the real members (bob alone, if anyone), all on Haxy's first page
    const url = new URL(route.request().url())
    const first = new URL(url)
    first.search = ""
    const real = (await (await route.fetch({ url: first.toString() })).json()) as { main_owner: string; items: unknown[] }
    const start = Number(url.searchParams.get("cursor") ?? "0")
    const size = Number(url.searchParams.get("page_size") ?? "20")
    if (start !== 1100) otherPages++
    const all = [...others, ...real.items]
    const next = start + size < all.length ? String(start + size) : null
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ main_owner: real.main_owner, items: all.slice(start, start + size), page: { has_more: next !== null, next_cursor: next, count: { kind: "unknown" } } }),
    })
  })
  let lookups = 0
  // every change lands, and its answer is lost
  await page.route(`**/api/v1/repos/*/tools/settings/members/${bob.name}`, async (route) => {
    if (route.request().method() === "GET") {
      lookups++
      return route.continue()
    }
    await route.fetch()
    await route.fulfill(internalError)
  })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members?cursor=1100`)
  const bobRow = page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: bob.name })
  await expect(bobRow).toContainText("Member")

  await bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText(`${bob.name} is an owner now`)
  expect(lookups).toBe(1)

  await bobRow.getByRole("button", { name: `Remove ${bob.name}` }).click()
  await bobRow.getByRole("button", { name: "Remove member" }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText(`${bob.name} isn't a member now`)
  expect(lookups).toBe(2)
  await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0)
  // only the page shown was read again, never a scan of the list
  expect(otherPages).toBe(0)
})

test("a settings save in progress takes no further edits, so what it says it saved is what the form shows", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/v1/repos/*/tools/settings", async (route) => {
    if (route.request().method() !== "PUT") return route.continue()
    await released
    await route.continue()
  })
  await form.getByRole("textbox", { name: "Description" }).fill("Submitted words")
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("textbox", { name: "Description" })).toBeDisabled()
  await expect(form.getByRole("group", { name: "Visibility" }).getByRole("radio", { name: /Private/ })).toBeDisabled()
  release()
  await expect(form.getByRole("status")).toHaveText("Settings saved.")
  await expect(form.getByRole("textbox", { name: "Description" })).toBeEnabled()
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Submitted words")
  expect(await (await owner.get(`${api}/settings`)).json()).toMatchObject({ description: "Submitted words" })
})

test("a settings save whose answer is lost but which landed refreshes the repository's header and sections too", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  await expect(sections(page).getByRole("link", { name: "Issues" })).toBeVisible()
  await page.route("**/api/v1/repos/*/tools/settings", async (route) => {
    if (route.request().method() !== "PUT") return route.continue()
    await route.fetch()
    await route.fulfill(internalError)
  })
  await form.getByRole("group", { name: "Visibility" }).getByRole("radio", { name: /Private/ }).check()
  await form.getByRole("group", { name: "Who can open issues" }).getByRole("radio", { name: /Nobody/ }).check()
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("alert")).toContainText("match what you submitted now, so they are saved")
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Private")
  await expect(sections(page).getByText("Issues")).toHaveCount(0)
})

test("the branch pickers always submit what they show, and a lost change whose check also fails blocks retries until checked", async ({ page, launch, playwright }) => {
  const { backend, hub } = await setUp(launch, playwright, "public", { ssh: true })
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "dev" }, { kind: "branch", name: "next" }] })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/branches`)
  const defaultForm = page.getByRole("form", { name: "Default branch" })
  const protect = page.getByRole("form", { name: "Protect a branch" })
  await defaultForm.getByLabel("Default branch").selectOption("branch:dev")
  await protect.getByLabel("Protect a branch").selectOption("branch:next")

  // the branch list fails to load again after another change (the protection below)
  await page.route("**/api/v1/repos/*/tools/branches*", (route) => route.abort("connectionreset"))
  await protect.getByLabel("Protect a branch").selectOption("branch:main")
  await protect.getByRole("button", { name: "Protect branch" }).click()
  await expect(page.getByRole("list", { name: "Protected branches" }).getByRole("listitem")).toHaveText(["mainUnprotect"])
  // still showing, and so still sending, dev
  await expect(defaultForm.getByLabel("Default branch")).toHaveValue("branch:dev")
  await expect(defaultForm.getByLabel("Default branch").locator("option:checked")).toHaveText("dev")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(defaultForm.getByRole("status")).toHaveText("The default branch is dev now.")

  // a protection that never lands, whose check fails too: no retry until a check succeeds
  await page.route("**/api/v1/repos/*/tools/settings/branches/protected", (route) => route.abort("connectionreset"))
  await page.route("**/api/v1/repos/*/tools/settings/branches", (route) => route.abort("connectionreset"))
  // (the list still can't be read, so the branch is named by typing it)
  await protect.getByLabel("Protect a branch").selectOption("other")
  await protect.getByLabel("Branch name").fill("dev")
  await protect.getByRole("button", { name: "Protect branch" }).click()
  await expect(protect.getByRole("alert")).toContainText("or say what the branches are now")
  await expect(protect.getByRole("button", { name: "Protect branch" })).toBeDisabled()
  await page.unroute("**/api/v1/repos/*/tools/settings/branches")
  await protect.getByRole("button", { name: "Check again" }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText("dev isn't protected now")
  await expect(protect.getByRole("button", { name: "Protect branch" })).toBeEnabled()
})

test("a settings save whose outcome and check both fail blocks saving until a check succeeds", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  let reads = "pass"
  await page.route("**/api/v1/repos/*/tools/settings", (route) => {
    if (route.request().method() === "PUT") return route.abort("connectionreset")
    return reads === "fail" ? route.abort("connectionreset") : route.continue()
  })
  await form.getByRole("textbox", { name: "Description" }).fill("Never sent")
  reads = "fail"
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("alert")).toContainText("couldn't say what the settings are now")
  await expect(form.getByRole("button", { name: "Save settings" })).toBeDisabled()
  reads = "pass"
  await form.getByRole("button", { name: "Check again" }).click()
  await expect(form.getByRole("alert")).toContainText("so yours weren't saved")
  await expect(form.getByRole("button", { name: "Save settings" })).toBeEnabled()
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Never sent")
})

test("a member change whose outcome and check both fail blocks that change until a check succeeds", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members`)
  const add = page.getByRole("form", { name: "Add a member" })
  const bobRow = page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: bob.name })
  await expect(bobRow).toContainText("Member")
  let reads = "pass"
  await page.route("**/api/v1/repos/*/tools/settings/members**", (route) => {
    if (route.request().method() !== "GET") return route.abort("connectionreset")
    return reads === "fail" ? route.abort("connectionreset") : route.continue()
  })
  reads = "fail"
  await add.getByLabel("Add a member").fill("carol")
  await add.getByRole("button", { name: "Add member" }).click()
  await expect(add.getByRole("alert")).toContainText("or say what carol's role is now")
  await expect(add.getByRole("button", { name: "Add member" })).toBeDisabled()

  await bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` }).click()
  await expect(bobRow.getByRole("alert")).toContainText(`or say what ${bob.name}'s role is now`)
  await expect(bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` })).toHaveCount(0)

  reads = "pass"
  await add.getByRole("button", { name: "Check again" }).click()
  await expect(page.getByRole("status").filter({ hasText: "carol isn't a member now" })).toBeVisible()
  await expect(add.getByRole("button", { name: "Add member" })).toBeEnabled()
  await bobRow.getByRole("button", { name: "Check again" }).click()
  await expect(page.getByRole("status").filter({ hasText: `${bob.name} is a member now` })).toBeVisible()
  await expect(bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` })).toBeEnabled()
})

test("while a lost save is unresolved the settings take no edits, so checking again can't replace newer ones", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  let reads = "pass"
  await page.route("**/api/v1/repos/*/tools/settings", async (route) => {
    // the save lands, but its answer is lost
    if (route.request().method() === "PUT") {
      await route.fetch()
      return route.abort("connectionreset")
    }
    return reads === "fail" ? route.abort("connectionreset") : route.continue()
  })
  await form.getByRole("textbox", { name: "Description" }).fill("Submitted words")
  reads = "fail"
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(form.getByRole("alert")).toContainText("couldn't say what the settings are now")
  await expect(form.getByRole("textbox", { name: "Description" })).toBeDisabled()
  await expect(form.getByRole("group", { name: "Visibility" }).getByRole("radio", { name: /Private/ })).toBeDisabled()
  reads = "pass"
  await form.getByRole("button", { name: "Check again" }).click()
  await expect(form.getByRole("alert")).toContainText("match what you submitted now, so they are saved")
  await expect(form.getByRole("textbox", { name: "Description" })).toBeEnabled()
  await expect(form.getByRole("textbox", { name: "Description" })).toHaveValue("Submitted words")
})

test("a member change that lands while another owner reverses it leaves the row usable", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name)
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members`)
  const bobRow = page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: bob.name })
  await expect(bobRow).toContainText("Member")
  await page.route(`**/api/v1/repos/*/tools/settings/members/${bob.name}`, async (route) => {
    if (route.request().method() === "GET") return route.continue()
    const response = await route.fetch()
    // another owner demotes bob again before the list is read
    const headers = { ...(await writeHeaders(owner, hub.url)), "Content-Type": "application/json" }
    expect((await owner.put(`${api}/settings/members/${bob.name}`, { headers, data: { role: "member" } })).status()).toBe(200)
    await route.fulfill({ response })
  })
  await bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` }).click()
  await expect(bobRow).toContainText("Member")
  await expect(bobRow.getByRole("button", { name: `Promote ${bob.name} to owner` })).toBeEnabled()
  await expect(bobRow.getByRole("button", { name: `Remove ${bob.name}` })).toBeEnabled()
})

test("a member addition in progress takes no further edits, so clearing the field after it loses nothing", async ({ page, launch, playwright }) => {
  const { hub } = await setUp(launch, playwright, "public")
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/members`)
  const add = page.getByRole("form", { name: "Add a member" })
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/v1/repos/*/tools/settings/members", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await released
    await route.continue()
  })
  await add.getByLabel("Add a member").fill(bob.name)
  await add.getByRole("button", { name: "Add member" }).click()
  await expect(add.getByLabel("Add a member")).toBeDisabled()
  release()
  await expect(add.getByRole("status")).toHaveText(`${bob.name} is a member now.`)
  await expect(add.getByLabel("Add a member")).toBeEnabled()
})

test("a default branch picked again right after a change isn't replaced by the change's refresh", async ({ page, launch, playwright }) => {
  const { backend, hub } = await setUp(launch, playwright, "public", { ssh: true })
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "dev" }] })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/branches`)
  const defaultForm = page.getByRole("form", { name: "Default branch" })
  await expect(defaultForm.getByLabel("Default branch")).toHaveValue("branch:main")
  // the refresh after the change is held back
  let release = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  let changed = false
  await page.route("**/api/v1/repos/*/tools/settings/branches", async (route) => {
    if (changed) await released
    await route.continue()
  })
  await page.route("**/api/v1/repos/*/tools/settings/branches/default", async (route) => {
    changed = true
    await route.continue()
  })
  await defaultForm.getByLabel("Default branch").selectOption("branch:dev")
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(defaultForm.getByRole("status")).toHaveText("The default branch is dev now.")
  await defaultForm.getByLabel("Default branch").selectOption("branch:main")
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/settings/branches"))
  release()
  await refreshed
  await page.waitForTimeout(300)
  await expect(defaultForm.getByLabel("Default branch")).toHaveValue("branch:main")
})

test("a granted owner whose own demotion lands with its answer lost is told they no longer manage the repository", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name, "owner")
  await logIn(page, hub.url, bob, `/repos/${alice.name}/tools/settings/members`)
  const bobRow = page.getByRole("list", { name: "Members" }).getByRole("listitem").filter({ hasText: bob.name })
  await page.route(`**/api/v1/repos/*/tools/settings/members/${bob.name}`, async (route) => {
    // the demotion lands and its answer is lost; the lookup that settles it reaches Haxy
    if (route.request().method() === "GET") return route.continue()
    await route.fetch()
    await route.abort("connectionreset")
  })
  await bobRow.getByRole("button", { name: `Demote ${bob.name} to member` }).click()
  await bobRow.getByRole("button", { name: "Demote to member" }).click()
  await expect(page.getByText("Only the repository's owners can manage it.")).toBeVisible()
  await expect(sections(page).getByText("Settings")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0)
})

test("a settings save lost while another owner took the saver's ownership away ends at the no-longer-an-owner answer", async ({ page, launch, playwright }) => {
  const { hub, owner, api } = await setUp(launch, playwright, "public")
  await grant(owner, hub.url, api, bob.name, "owner")
  await logIn(page, hub.url, bob, `/repos/${alice.name}/tools/settings`)
  const form = page.getByRole("form", { name: "Repository settings" })
  await page.route("**/api/v1/repos/*/tools/settings", async (route) => {
    if (route.request().method() !== "PUT") return route.continue()
    // alice removes bob, and bob's save never gets an answer
    const headers = { ...(await writeHeaders(owner, hub.url)), "Content-Type": "application/json" }
    expect((await owner.delete(`${api}/settings/members/${bob.name}`, { headers })).status()).toBe(200)
    await route.abort("connectionreset")
  })
  await form.getByRole("textbox", { name: "Description" }).fill("By bob")
  await form.getByRole("button", { name: "Save settings" }).click()
  await expect(page.getByText("Only the repository's owners can manage it.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0)
})

test("a default-branch change settled after its answer was lost sets the picker's baseline, so a branch picked before the refresh stays", async ({ page, launch, playwright }) => {
  const { backend, hub } = await setUp(launch, playwright, "public", { ssh: true })
  await pushRepo(playwright, backend, hub.url, alice, { owner: alice.name, name: "tools" }, { refs: [{ kind: "branch", name: "dev" }, { kind: "branch", name: "next" }] })
  await logIn(page, hub.url, alice, `/repos/${alice.name}/tools/settings/branches`)
  const defaultForm = page.getByRole("form", { name: "Default branch" })
  const picker = defaultForm.getByLabel("Default branch")
  await expect(picker).toHaveValue("branch:main")

  // what each read of the branches after a change does, in order: pass, fail,
  // or wait until released (later reads pass)
  let plan: Array<"pass" | "fail" | "hold"> = []
  let release = () => {}
  let held = false
  await page.route("**/api/v1/repos/*/tools/settings/branches", async (route) => {
    const step = plan.shift() ?? "pass"
    if (step === "fail") return route.abort("connectionreset")
    if (step === "hold") {
      held = true
      await new Promise<void>((resolve) => { release = resolve })
    }
    await route.continue()
  })
  // every change lands, and its answer is lost
  await page.route("**/api/v1/repos/*/tools/settings/branches/default", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })

  // the settling read finds dev; the refresh after it is held while main is picked again
  await picker.selectOption("branch:dev")
  plan = ["pass", "hold"]
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText("the default branch is dev now")
  await expect.poll(() => held).toBe(true)
  await picker.selectOption("branch:main")
  release()
  await page.waitForTimeout(500)
  await expect(picker).toHaveValue("branch:main")

  // the same through "Check again": the settling read fails, the check finds next
  held = false
  await picker.selectOption("branch:next")
  plan = ["fail", "pass", "hold"]
  await defaultForm.getByRole("button", { name: "Change default branch" }).click()
  await defaultForm.getByRole("button", { name: "Check again" }).click()
  await expect(page.getByRole("status").filter({ hasText: "may or may not be from this attempt" })).toContainText("the default branch is next now")
  await expect.poll(() => held).toBe(true)
  await picker.selectOption("branch:dev")
  release()
  await page.waitForTimeout(500)
  await expect(picker).toHaveValue("branch:dev")
})
