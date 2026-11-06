import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice, registerUser, type Account } from "./support/accounts"
import { branchIds, divergedIssue, divergedPatch, getJson, localApi, localSide, sendJson, serverApi, serverSide } from "./support/conflicts"
import { createBranchPatch, divergeBranch, setPatchRole } from "./support/patches"
import { pushRepo } from "./support/push"
import { localGit } from "./support/history"
import { createRepo, signedIn } from "./support/repos"

// Metadata conflicts in the browser, through Vite's proxy against real Haxy
// processes whose conflicts come from Haxy's own sync of divergent edits.
// Every resolution is checked again after a reload, and through the API.

type Detail = { title: string; description_text: string; conflicted: boolean; target?: { id: string } }
type Answer = { conflict: { revision: string } | null }

const resolvePage = (page: Page) => page.getByRole("form", { name: /Resolve the .*'s conflict/ })
const fieldset = (page: Page, name: string) => resolvePage(page).getByRole("group", { name, exact: true })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page.getByText(`Signed in as ${account.name}`)).toBeVisible()
}

test("an issue's conflict banner leads to both sides and their authors; resolving records the choice, and the conflict is gone after a reload", async ({ page, playwright, request, launch }) => {
  const { hub, id } = await divergedIssue(playwright, request, launch)

  await page.goto(`${hub.url}/repo/issues/${id}`)
  await expect(page.getByText("Concurrent edits to this issue conflict")).toBeVisible()
  await page.getByRole("link", { name: "Resolve the conflict" }).click()
  await expect(page.getByRole("heading", { name: "Resolve metadata conflict" })).toBeVisible()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/${id}/conflict`)

  const title = fieldset(page, "Title")
  await expect(title.getByRole("group", { name: "Current" })).toContainText(localSide.title)
  const theirs = title.getByRole("group", { name: "Merged in" })
  await expect(theirs).toContainText(serverSide.title)
  await expect(theirs).toContainText(`edited by ${alice.email}`)
  await theirs.getByRole("button", { name: "Use this" }).click()
  await expect(title.getByLabel("Resolved title")).toHaveValue(serverSide.title)

  const part = resolvePage(page).getByRole("group", { name: "Conflicting part 1" })
  await expect(part.getByRole("group", { name: "Current" })).toContainText("Local words.")
  await expect(part.getByRole("group", { name: "Merged in" })).toContainText("Server words.")
  await expect(part.getByLabel("Resolved part 1")).toHaveValue("Local words.")
  await part.getByLabel("Resolved part 1").fill("Both sides' words.")
  await resolvePage(page).getByRole("button", { name: "Resolve conflict" }).click()

  await expect(page).toHaveURL(`${hub.url}/repo/issues/${id}`)
  await expect(page.getByRole("heading", { name: serverSide.title })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { name: serverSide.title })).toBeVisible()
  await expect(page.getByText("Both sides' words.")).toBeVisible()
  await expect(page.getByText("Concurrent edits to this issue conflict")).toHaveCount(0)
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/issues/${id}`)).toMatchObject({ title: serverSide.title, description_text: "Intro.\nBoth sides' words.\nOutro.", conflicted: false })
})

test("the issues' conflicts tab lists the conflicted issue and leads to its resolution", async ({ page, playwright, request, launch }) => {
  const { hub, id } = await divergedIssue(playwright, request, launch)

  await page.goto(`${hub.url}/repo/issues`)
  await page.getByRole("navigation", { name: "Issue lists" }).getByRole("link", { name: "Conflicts" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/conflicts`)
  const list = page.getByRole("list", { name: "Conflicted issues" })
  await expect(list.getByRole("listitem")).toHaveCount(1)
  await list.getByRole("link", { name: localSide.title }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/${id}/conflict`)
  await resolvePage(page).getByRole("button", { name: "Resolve conflict" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/${id}`)

  await page.goto(`${hub.url}/repo/issues/conflicts`)
  await expect(page.getByRole("heading", { name: "No issues with metadata conflicts" })).toBeVisible()
  // the resolution kept this side everywhere
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/issues/${id}`)).toMatchObject({ title: localSide.title, description_text: localSide.description, conflicted: false })
})

test("a patch's target is resolved by taking one side whole, beside its text fields", async ({ page, playwright, request, launch }) => {
  const { hub, id } = await divergedPatch(playwright, request, launch)

  await page.goto(`${hub.url}/repo/patches/${id}`)
  await page.getByRole("link", { name: "Resolve the conflict" }).click()
  const target = fieldset(page, "Target branch")
  await expect(target.getByRole("radio", { name: "Current target branch" })).toBeChecked()
  await expect(target).toContainText("release-a")
  await expect(target).toContainText("release-b")
  await target.getByRole("radio", { name: "Merged in target branch" }).check()
  await fieldset(page, "Title").getByLabel("Resolved title").fill("Merged patch")
  await resolvePage(page).getByRole("button", { name: "Resolve conflict" }).click()

  await expect(page).toHaveURL(`${hub.url}/repo/patches/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { name: "Merged patch" })).toBeVisible()
  await expect(page.getByText("Concurrent edits to this patch conflict")).toHaveCount(0)
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/patches/${id}`)).toMatchObject({ title: "Merged patch", conflicted: false, target: { id: branchIds.server } })
})

test("a resolution made from a conflict that changed meanwhile is refused; loading it again shows the conflict as it is", async ({ page, playwright, request, launch }) => {
  const { hub, id } = await divergedIssue(playwright, request, launch)
  await page.goto(`${hub.url}/repo/issues/${id}/conflict`)
  await expect(resolvePage(page)).toBeVisible()

  // another client resolves it first
  const loaded = await getJson<Answer>(request, `${hub.url}${localApi}/issues/${id}/conflict`)
  await sendJson(request, hub.url, "POST", `${localApi}/issues/${id}/conflict`, { revision: loaded.conflict!.revision, title: "Theirs first" })

  await fieldset(page, "Title").getByLabel("Resolved title").fill("Mine")
  await resolvePage(page).getByRole("button", { name: "Resolve conflict" }).click()
  await expect(page.getByRole("alert")).toContainText("This conflict changed since you loaded it")
  await page.getByRole("button", { name: "Load the current conflict" }).click()
  await expect(page.getByText("This issue has no metadata conflict to resolve.")).toBeVisible()
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/issues/${id}`)).toMatchObject({ title: "Theirs first", conflicted: false })
})

test("on a server, a reader sees the conflict's sides but only a writer may resolve it", async ({ page, playwright, request, launch }) => {
  const { server, serverHub, owner, id } = await divergedIssue(playwright, request, launch)
  const bob: Account = { name: "bobby", email: "bobby@example.test", password: "battery staple horse" }
  await registerUser(server, bob)
  const route = `/repos/${alice.name}/shared/issues/${id}/conflict`

  await page.goto(`${serverHub.url}${route}`)
  await expect(page.getByText("Log in to resolve conflicts.")).toBeVisible()
  await logIn(page, serverHub.url, bob, route)
  await expect(page.getByText("Only the repository's writers can resolve conflicts.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Resolve conflict" })).toHaveCount(0)

  await page.context().clearCookies()
  await logIn(page, serverHub.url, alice, route)
  await resolvePage(page).getByRole("button", { name: "Resolve conflict" }).click()
  await expect(page).toHaveURL(`${serverHub.url}/repos/${alice.name}/shared/issues/${id}`)
  await page.reload()
  await expect(page.getByText("Concurrent edits to this issue conflict")).toHaveCount(0)
  expect((await getJson<Detail>(owner, `${serverHub.url}${serverApi}/issues/${id}`)).conflicted).toBe(false)
})

test("a patch whose code conflicts with its target shows that as its mergeability, never as a metadata conflict", async ({ page, playwright, launch }) => {
  const server = await launch.server({ ssh: true })
  const hub = await launch.hub(server.port)
  await registerUser(server, alice)
  const owner = await signedIn(playwright, server, hub.url, alice.name, alice.password)
  await createRepo(owner, server, { name: "clash", access: "public" })
  await pushRepo(playwright, server, hub.url, alice, { owner: alice.name, name: "clash" }, {
    files: { "README.md": "# clash\n", "shared.txt": "base\n" },
    history: (git) => { divergeBranch(git, "feature", [{ message: "Ours", files: { "shared.txt": "feature\n" } }], [{ message: "Theirs", files: { "shared.txt": "main\n" } }]) },
  })
  await setPatchRole(owner, server, { owner: alice.name, name: "clash", access: "public" }, "anybody")
  const id = await createBranchPatch(owner, server, `/${alice.name}:clash`, { title: "Clashes", source: "feature", target: "main" })

  await page.goto(`${hub.url}/repos/${alice.name}/clash/patches/${id}`)
  await expect(page.getByText("conflicts with the target").first()).toBeVisible()
  await expect(page.getByText("Concurrent edits to this patch conflict")).toHaveCount(0)
  await page.goto(`${hub.url}/repos/${alice.name}/clash/patches/conflicts`)
  await expect(page.getByRole("heading", { name: "No patches with metadata conflicts" })).toBeVisible()
  await page.goto(`${hub.url}/repos/${alice.name}/clash/patches/${id}/conflict`)
  await expect(page.getByText("This patch has no metadata conflict to resolve.")).toBeVisible()
})

test("Haxy's own conflicts and resolve URLs in Markdown open the Hub's conflict pages", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const target = "0123456789abcdef0123456789abcdef"
  const description = `[issue conflicts](/issues/conflicts) [resolve it](/issue:${target}/theirs:title/resolve) [patch conflicts](/patches/start:${target}/conflicts)`
  const issue = (await sendJson(request, hub.url, "POST", `${localApi}/issues`, { title: "Links", labels: "", description })) as { id: string }

  await page.goto(`${hub.url}/repo/issues/${issue.id}`)
  await expect(page.getByRole("link", { name: "issue conflicts" })).toHaveAttribute("href", "/repo/issues/conflicts")
  await expect(page.getByRole("link", { name: "resolve it" })).toHaveAttribute("href", `/repo/issues/${target}/conflict`)
  await expect(page.getByRole("link", { name: "patch conflicts" })).toHaveAttribute("href", "/repo/patches/conflicts")
})

test("a refusal of a field the resolution form doesn't show, such as a deleted source branch, is listed with its label", async ({ page, playwright, request, launch }) => {
  const { hub, local, id } = await divergedPatch(playwright, request, launch)
  await page.goto(`${hub.url}/repo/patches/${id}/conflict`)
  await expect(resolvePage(page)).toBeVisible()
  localGit(local)(["branch", "-D", "feature"])

  await fieldset(page, "Target branch").getByRole("radio", { name: "Merged in target branch" }).check()
  await resolvePage(page).getByRole("button", { name: "Resolve conflict" }).click()
  await expect(page.getByRole("alert")).toContainText("Source branch: There is no such branch")
  await page.reload()
  await expect(fieldset(page, "Target branch").getByRole("radio", { name: "Current target branch" })).toBeChecked()
  expect(await getJson<Detail>(request, `${hub.url}${localApi}/patches/${id}`)).toMatchObject({ conflicted: true, target: { id: branchIds.local } })
})
