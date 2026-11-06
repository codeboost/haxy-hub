import { writeFileSync } from "node:fs"
import path from "node:path"
import type { Page, Route } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { expect, test } from "./support/fixtures"
import { localGit } from "./support/history"
import { closePatch, createBranchPatch, divergeBranch, editPatch, removePatch, setPatchRole, tuiPatchPage, tuiPatches } from "./support/patches"
import { pushRepo } from "./support/push"
import { createRepo, signedIn } from "./support/repos"

// Opening a branch-backed patch, editing it, closing, reopening and removing
// it in the browser (#18), through Vite's proxy against a real Haxy. Every
// change is checked again after a refresh, in Haxy's own server-rendered
// patches pages (the TUI's).

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")
const actions = (page: Page) => page.getByRole("group", { name: "Patch actions" })
const proposal = (page: Page) => page.getByRole("region", { name: "Proposal" })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Counts the writes (anything but GET and HEAD) the page sends to routes matching `pattern`. */
function countWrites(page: Page, pattern: RegExp) {
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.method() !== "HEAD" && pattern.test(new URL(request.url()).pathname)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Handles the first `method` request to `pattern` with `handler`; every other request goes on as usual. */
async function onFirst(page: Page, pattern: RegExp, method: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

/** A local repository whose `feature` is one commit ahead of `main`, and an `other` branch at `main`. */
async function branchedLocal(launch: { local(): Promise<Backend> }) {
  const backend = await launch.local()
  const git = localGit(backend)
  divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }])
  git(["branch", "other", "main"])
  return backend
}

test("local mode opens a patch from two branches, edits and retargets it, closes, reopens and removes it", async ({ page, launch }) => {
  let backend = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo/patches`)
  await page.getByRole("link", { name: "New patch" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  // the target starts at the default branch; the source must be chosen
  await expect(form.getByLabel("Target branch")).toHaveValue("branch:main")
  await form.getByLabel("Title").fill("Add a parser")
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(form.getByText("Choose one of the repository's branches.")).toBeVisible()
  await expect(form.getByLabel("Title")).toHaveValue("Add a parser")
  // the same branch twice is refused beside the target
  await form.getByLabel("Source branch").selectOption({ label: "main" })
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(form.getByText("Choose another branch than the source.")).toBeVisible()
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([])

  await form.getByLabel("Source branch").selectOption({ label: "feature" })
  await form.getByLabel("Labels").fill("parser")
  await form.getByLabel("Description").fill("Parses **things**.")
  // a double click opens one patch
  const writes = countWrites(page, /\/api\/v1\/repo\/patches$/)
  await form.getByRole("button", { name: "Open patch" }).dblclick()
  await expect(page).toHaveURL(/\/repo\/patches\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!
  expect(writes).toEqual(["POST /api/v1/repo/patches"])
  for (const step of ["refresh", "restart"] as const) {
    if (step === "restart") backend = await backend.restart!()
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "Add a parser" }), step).toBeVisible()
    await expect(proposal(page)).toContainText("Branch feature")
    await expect(proposal(page)).toContainText("Branch main")
    await expect(page.getByRole("region", { name: "Labels" }).getByRole("link")).toHaveText(["parser"])
    expect((await tuiPatches(backend, "", "open")).ids, step).toEqual([id])
  }

  // editing: the form holds the patch's fields and target; a new target is a new proposal
  await actions(page).getByRole("link", { name: "Edit" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${id}/edit`)
  const edit = page.getByRole("form", { name: "Edit patch" })
  await expect(edit.getByLabel("Title")).toHaveValue("Add a parser")
  await expect(edit.getByLabel("Description")).toHaveValue("Parses **things**.")
  await expect(edit.getByLabel("Target branch")).toHaveValue("branch:main")
  await expect(edit.getByLabel("Source branch")).toHaveCount(0)
  await edit.getByLabel("Title").fill("Add a parser, tested")
  await edit.getByLabel("Target branch").selectOption({ label: "other" })
  await edit.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Add a parser, tested" })).toBeVisible()
  await expect(proposal(page)).toContainText("Branch other")
  expect(await tuiPatchPage(backend, "", id)).toContain("Add a parser, tested")

  // closing: a double click is one write, even once the button became "Reopen patch"
  const statusWrites = countWrites(page, /\/status$/)
  await actions(page).getByRole("button", { name: "Close patch" }).dblclick({ delay: 400 })
  await expect(actions(page).getByRole("button", { name: "Reopen patch" })).toBeVisible()
  expect(statusWrites).toHaveLength(1)
  await expect(page.getByLabel("Status")).toHaveText("Closed")
  await page.reload()
  await expect(page.getByLabel("Status")).toHaveText("Closed")
  expect((await tuiPatches(backend, "", "closed")).ids).toEqual([id])
  await actions(page).getByRole("button", { name: "Reopen patch" }).click()
  await expect(actions(page).getByRole("button", { name: "Close patch" })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Status")).toHaveText("Open")
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([id])

  // removing asks first; cancelling changes nothing
  await actions(page).getByRole("button", { name: "Remove" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Remove this patch?" })
  await expect(confirm).toContainText("Add a parser, tested")
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  const removals = countWrites(page, /\/patches\/[0-9a-f]{32}$/)
  await actions(page).getByRole("button", { name: "Remove" }).click()
  await confirm.getByRole("button", { name: "Remove patch" }).dblclick()
  await expect(page).toHaveURL(`${hub.url}/repo/patches`)
  expect(removals).toEqual([`DELETE /api/v1/repo/patches/${id}`])
  await expect(page.getByText("No open patches")).toBeVisible()
  await page.goto(`${hub.url}/repo/patches/${id}`)
  await expect(page.getByRole("heading", { name: "Patch not found" })).toBeVisible()
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([])
  expect((await tuiPatches(backend, "", "closed")).ids).toEqual([])
})

test("Haxy's own links to its patch forms open Hub's", async ({ page, request, launch }) => {
  const backend = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)
  const patch = await createBranchPatch(request, backend, "", { title: "Add a parser", source: "feature", target: "main" })
  const linking = await createBranchPatch(request, backend, "", { title: "Links", source: "other", target: "main", description: `[Propose more](/patches/new) or [edit the parser](/patch:${patch}/edit).` })
  await page.goto(`${hub.url}/repo/patches/${linking}`)
  await page.getByRole("link", { name: "Propose more" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/new`)
  await expect(page.getByRole("form", { name: "New patch" })).toBeVisible()
  await page.goBack()
  await page.getByRole("link", { name: "edit the parser" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${patch}/edit`)
  await expect(page.getByRole("form", { name: "Edit patch" }).getByLabel("Title")).toHaveValue("Add a parser")
})

test("a default branch whose name shows ambiguously is never picked as the target by its look-alike", async ({ page, launch }) => {
  // two branches whose names aren't UTF-8 and show alike ("caf\uFFFD"), the default one of them
  const e8 = Uint8Array.from([...Buffer.from("caf"), 0xe8])
  const e9 = Uint8Array.from([...Buffer.from("caf"), 0xe9])
  const backend = await launch.local({ refs: [{ kind: "branch", name: e8, files: { "e8.txt": "e8\n" } }, { kind: "branch", name: e9, files: { "e9.txt": "e9\n" } }] })
  writeFileSync(path.join(backend.dataDir, ".git", "HEAD"), Buffer.concat([Buffer.from("ref: refs/heads/"), Buffer.from(e9), Buffer.from("\n")]))
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/patches/new`)
  const target = page.getByRole("form", { name: "New patch" }).getByLabel("Target branch")
  await expect(target.getByRole("option", { name: "caf\uFFFD" })).toHaveCount(2)
  // the form can't tell which of the two is the default, so it picks neither
  await expect(target).toHaveValue("")
})

test("a refusal naming a branch the page doesn't show says why", async ({ page, request, launch }) => {
  const backend = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)
  const id = await createBranchPatch(request, backend, "", { title: "Add a parser", source: "feature", target: "main" })
  await closePatch(request, backend, "", id)
  localGit(backend)(["branch", "-D", "feature"])

  // reopening captures the source again, which is gone
  await page.goto(`${hub.url}/repo/patches/${id}`)
  await actions(page).getByRole("button", { name: "Reopen patch" }).click()
  await expect(page.getByRole("alert")).toContainText("There is no such branch.")
  await expect(page.getByLabel("Status")).toHaveText("Closed")

  // so does retargeting it, though the edit form has no source picker
  await actions(page).getByRole("link", { name: "Edit" }).click()
  const form = page.getByRole("form", { name: "Edit patch" })
  await form.getByLabel("Target branch").selectOption({ label: "other" })
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByRole("alert")).toContainText("Source branch: There is no such branch.")
  expect(await tuiPatchPage(backend, "", id)).toContain("Add a parser")
})

test("an edit based on a version someone else changed is refused until the current version, target included, has been seen", async ({ page, request, launch }) => {
  const backend = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)
  const id = await createBranchPatch(request, backend, "", { title: "First title", source: "feature", target: "main" })

  await page.goto(`${hub.url}/repo/patches/${id}/edit`)
  const form = page.getByRole("form", { name: "Edit patch" })
  await form.getByLabel("Title").fill("My title")
  // another client (Haxy's own edit form) retargets it meanwhile
  await editPatch(request, backend, "", id, { title: "Their title", target: "other" })
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByRole("alert")).toContainText("Someone changed this patch since you opened the form")
  await expect(form.getByRole("button", { name: "Save changes" })).toBeDisabled()
  expect(await tuiPatchPage(backend, "", id)).toContain("Their title")

  await form.getByRole("button", { name: "Show the current version" }).click()
  const current = form.getByRole("region", { name: "Current version" })
  await expect(current).toContainText("Their title")
  await expect(current).toContainText("other")
  await expect(form.getByLabel("Title")).toHaveValue("My title")
  await expect(form.getByLabel("Target branch")).toHaveValue("branch:main")
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "My title" })).toBeVisible()
  await expect(proposal(page)).toContainText("Branch main")
  expect(await tuiPatchPage(backend, "", id)).toContain("My title")
})

test("a creation whose answer is lost is looked up by its id; a lost status answer is settled by reading the patch", async ({ page, request, launch }) => {
  const backend = await branchedLocal(launch)
  const hub = await launch.hub(backend.port)
  const create = /\/api\/v1\/repo\/patches$/

  // Haxy opens the patch, but its answer never arrives
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  await onFirst(page, create, "POST", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })
  await form.getByLabel("Title").fill("Lost answer")
  await form.getByLabel("Source branch").selectOption({ label: "feature" })
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(form.getByText("The patch was opened.")).toBeVisible()
  await expect(form.getByRole("button", { name: "Open patch" })).toBeDisabled()
  const opened = (await tuiPatches(backend, "", "open")).ids
  expect(opened).toHaveLength(1)

  // opened and removed before the form looked it up: a retry is refused, the draft kept
  await page.goto(`${hub.url}/repo/patches/new`)
  let removedId = ""
  await onFirst(page, create, "POST", async (route) => {
    const response = await route.fetch()
    removedId = ((await response.json()) as { id: string }).id
    await removePatch(request, backend, "", removedId)
    await route.abort("connectionreset")
  })
  await form.getByLabel("Title").fill("Removed meanwhile")
  await form.getByLabel("Source branch").selectOption({ label: "feature" })
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(form.getByText("nothing was opened")).toBeVisible()
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(form.getByText("was opened and then removed")).toBeVisible()
  await form.getByRole("button", { name: "Open it as a new patch" }).click()
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(page).toHaveURL(/\/repo\/patches\/[0-9a-f]{32}$/)
  expect(page.url()).not.toContain(removedId)
  expect((await tuiPatches(backend, "", "open")).ids).toHaveLength(2)

  // closing lands, but its answer is lost: the page reads the patch and shows it closed
  await expect(page.getByRole("heading", { level: 2, name: "Removed meanwhile" })).toBeVisible()
  await onFirst(page, /\/status$/, "PUT", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })
  await actions(page).getByRole("button", { name: "Close patch" }).click()
  await expect(page.getByRole("alert")).toContainText("This is the patch as it is now.")
  await expect(actions(page).getByRole("button", { name: "Reopen patch" })).toBeVisible()
  await expect(page.getByLabel("Status")).toHaveText("Closed")
})

test.describe("on a server", () => {
  test("readers get no write controls; a reader opens and changes their own patch, and is refused once their role is revoked", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    await registerUser(backend, alice)
    await registerUser(backend, bob)
    const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
    const repo = { owner: "alice", name: "parser", access: "public" } as const
    await createRepo(owner, backend, repo)
    await pushRepo(playwright, backend, hub.url, alice, repo, {
      files: { "README.md": "# parser\n" },
      history: (git) => { divergeBranch(git, "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }]) },
    })
    await setPatchRole(owner, backend, repo, "members")
    const owners = await createBranchPatch(owner, backend, "/alice:parser", { title: "Owner's patch", source: "feature", target: "main" })

    // anonymous: nothing to write with, and the forms say why
    await page.goto(`${hub.url}/repos/alice/parser/patches`)
    await expect(page.getByRole("link", { name: "Owner's patch" })).toBeVisible()
    await expect(page.getByRole("link", { name: "New patch" })).toHaveCount(0)
    await page.goto(`${hub.url}/repos/alice/parser/patches/${owners}`)
    await expect(page.getByRole("heading", { level: 2, name: "Owner's patch" })).toBeVisible()
    await expect(actions(page)).toHaveCount(0)
    await page.goto(`${hub.url}/repos/alice/parser/patches/new`)
    await expect(page.getByText("to open a patch.")).toBeVisible()
    await page.goto(`${hub.url}/repos/alice/parser/patches/${owners}/edit`)
    await expect(page.getByText("Log in to change this patch.")).toBeVisible()

    // a reader below the patches tab's role
    await logIn(page, hub.url, bob, "/repos/alice/parser/patches/new")
    await expect(page.getByText("Your role in this repository doesn't allow opening patches.")).toBeVisible()
    await expect(page.getByRole("form", { name: "New patch" })).toHaveCount(0)

    // once anybody who can read may write patches, bob opens one, and may change only his own
    await setPatchRole(owner, backend, repo, "anybody")
    await page.goto(`${hub.url}/repos/alice/parser/patches`)
    await page.getByRole("link", { name: "New patch" }).click()
    const form = page.getByRole("form", { name: "New patch" })
    await form.getByLabel("Title").fill("Bob's take")
    await form.getByLabel("Source branch").selectOption({ label: "feature" })
    await form.getByRole("button", { name: "Open patch" }).click()
    await expect(page).toHaveURL(/\/repos\/alice\/parser\/patches\/[0-9a-f]{32}$/)
    const his = page.url().split("/").pop()!
    await expect(actions(page).getByRole("button", { name: "Close patch" })).toBeVisible()
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([his, owners])
    await page.goto(`${hub.url}/repos/alice/parser/patches/${owners}`)
    await expect(page.getByRole("heading", { level: 2, name: "Owner's patch" })).toBeVisible()
    await expect(actions(page)).toHaveCount(0)

    // a role revoked after the page loaded is refused, not a false success
    await page.goto(`${hub.url}/repos/alice/parser/patches/${his}`)
    await expect(actions(page).getByRole("button", { name: "Close patch" })).toBeVisible()
    await setPatchRole(owner, backend, repo, "members")
    await actions(page).getByRole("button", { name: "Close patch" }).click()
    await expect(page.getByRole("alert")).toContainText("Your role in this repository doesn't allow writing patches.")
    await page.reload()
    await expect(page.getByLabel("Status")).toHaveText("Open")
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([his, owners])
    await owner.dispose()
  })

  test.describe("with the demo data", () => {
    test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

    test("a merged patch offers editing and removal, never closing", async ({ page, launch }) => {
      const backend = await launch.demo()
      const hub = await launch.hub(backend.port)
      await logIn(page, hub.url, { name: "admin", email: "admin@example.test", password: "password" }, "/repos/admin/toolbox/patches/merged")
      await page.getByRole("list", { name: "Merged patches" }).getByRole("link", { name: /legacy configuration loader$/ }).click()
      await expect(page.getByLabel("Status")).toHaveText("Merged")
      await expect(actions(page).getByRole("link", { name: "Edit" })).toBeVisible()
      await expect(actions(page).getByRole("button", { name: "Remove" })).toBeVisible()
      await expect(actions(page).getByRole("button", { name: /Close|Reopen/ })).toHaveCount(0)
    })
  })
})
