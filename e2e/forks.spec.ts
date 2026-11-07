import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { APIRequestContext, Page } from "@playwright/test"
import { alice, logOutFromHeader, writeHeaders, type Account } from "./support/accounts"
import { bob, tuiPage } from "./support/drafts"
import { expect, test } from "./support/fixtures"
import { bobsFork } from "./support/forks"

// Browsing a fork's files, commits and diff, a user's forks, a fork whose
// target was deleted, and deleting a fork, in the browser through Vite's
// proxy against a real Haxy server. Changes are checked again after a
// refresh, and in Haxy's own server-rendered pages (the TUI's).

const header = (page: Page) => page.getByRole("banner")
const tabs = (page: Page) => page.getByRole("navigation", { name: "Fork" })
const about = (page: Page) => page.getByRole("region", { name: "About this fork" })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

async function apiWrite(context: APIRequestContext, hubUrl: string, method: string, url: string, body?: unknown) {
  const response = await context.fetch(`${hubUrl}${url}`, { method, headers: { ...(await writeHeaders(context, hubUrl)), "Content-Type": "application/json" }, data: body === undefined ? undefined : JSON.stringify(body) })
  expect(response.status(), await response.text()).toBe(200)
}

test.describe("on a server", () => {
  test("a fork's owner browses its files, commits and diff, and its draft", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id } = await bobsFork(playwright, backend, hub.url)
    const forkPage = `/forks/bobby/parser/${id}`
    await logIn(page, hub.url, bob, `/repos/alice/parser/patches/drafts/${id}`)

    await page.getByRole("link", { name: "Browse the fork" }).click()
    await expect(page).toHaveURL(`${hub.url}${forkPage}`)
    await expect(page.getByRole("heading", { level: 1, name: "Document the parser" })).toBeVisible()
    await expect(about(page)).toContainText("Draft")
    await expect(about(page)).toContainText("alice/parser")
    await expect(about(page)).toContainText("1 commit")
    await expect(page.getByRole("region", { name: "Push to this fork from an existing repository" })).toContainText(`bobby:parser+${id} HEAD:patch`)

    await tabs(page).getByRole("link", { name: "Files" }).click()
    await page.getByRole("link", { name: "PARSER.md" }).click()
    await expect(page.getByText("How the parser works.")).toBeVisible()
    await page.reload()
    await expect(page.getByText("How the parser works.")).toBeVisible()

    await tabs(page).getByRole("link", { name: "Commits" }).click()
    await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem")).toHaveCount(1)
    await expect(page.getByRole("list", { name: "Commits" })).toContainText("Document the parser")

    await tabs(page).getByRole("link", { name: "Diff" }).click()
    await expect(page).toHaveURL(`${hub.url}${forkPage}/diff`)
    await expect(page.getByRole("main")).toContainText("PARSER.md")
    await expect(page.getByRole("region", { name: "Changes" })).toContainText("A new file")

    await tabs(page).getByRole("link", { name: "Patch" }).click()
    await about(page).getByRole("link", { name: "Open the draft" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/drafts/${id}`)
    await owner.dispose()
    await forker.dispose()
  })

  test("a user's page lists the forks the viewer may see, and a reader may not delete one", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id } = await bobsFork(playwright, backend, hub.url)

    await page.goto(`${hub.url}/users/bobby`)
    const forks = page.getByRole("list", { name: "Forks" })
    await expect(forks).toContainText("parser")
    await forks.getByRole("link", { name: "Document the parser" }).click()
    await expect(page).toHaveURL(`${hub.url}/forks/bobby/parser/${id}`)
    await expect(about(page)).not.toContainText("Open the draft")
    await expect(tabs(page).getByRole("link", { name: "Delete" })).toHaveCount(0)

    await page.goto(`${hub.url}/forks/bobby/parser/${id}/delete`)
    await expect(page.getByRole("status")).toContainText("Log in as the fork's owner to delete it.")
    await owner.dispose()
    await forker.dispose()
  })

  test("a fork whose target was deleted says what its owner can still do", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker } = await bobsFork(playwright, backend, hub.url)
    await apiWrite(owner, hub.url, "DELETE", "/api/v1/repos/alice/parser", { confirm: "alice:parser", password: alice.password })

    await logIn(page, hub.url, bob, "/users/bobby")
    await expect(page.getByRole("list", { name: "Forks" })).toContainText("Target deleted")
    await page.getByRole("link", { name: "Document the parser" }).click()
    const deleted = page.getByRole("region", { name: "Target deleted" })
    await expect(deleted).toContainText("The repository this fork was made from has been deleted.")
    await expect(deleted).toContainText("can't be pushed to, published or merged")
    await expect(page.getByRole("region", { name: "Clone this fork" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Push to this fork from an existing repository" })).toHaveCount(0)
    await tabs(page).getByRole("link", { name: "Files" }).click()
    await expect(page.getByRole("link", { name: "PARSER.md" })).toBeVisible()
    await owner.dispose()
    await forker.dispose()
  })

  test("only its owner deletes a fork, with its typed name and their password", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id } = await bobsFork(playwright, backend, hub.url)
    const forkPage = `/forks/bobby/parser/${id}`

    await logIn(page, hub.url, alice, `${forkPage}/delete`)
    await expect(page.getByRole("status")).toContainText("Only the fork's owner can delete it.")
    await expect(page.getByRole("button", { name: "Permanently delete this fork" })).toHaveCount(0)
    await logOutFromHeader(page)

    await logIn(page, hub.url, bob, forkPage)
    await tabs(page).getByRole("link", { name: "Delete" }).click()
    const form = page.getByRole("form", { name: "Delete fork" })
    await form.getByLabel("Type bobby:parser to confirm").fill("bobby:parse")
    await form.getByLabel("Password").fill(bob.password)
    await form.getByRole("button", { name: "Permanently delete this fork" }).click()
    await expect(form).toContainText("Type bobby:parser exactly to confirm.")
    await expect(page).toHaveURL(`${hub.url}${forkPage}/delete`)

    await form.getByLabel("Type bobby:parser to confirm").fill("bobby:parser")
    await form.getByLabel("Password").fill(bob.password)
    await form.getByRole("button", { name: "Permanently delete this fork" }).click()
    await expect(page).toHaveURL(`${hub.url}/users/bobby`)
    await expect(page.getByRole("region", { name: "Forks", exact: true })).toContainText("No forks")

    await page.goto(`${hub.url}${forkPage}`)
    await expect(page.getByRole("heading", { level: 1, name: "Fork not found" })).toBeVisible()
    await page.goto(`${hub.url}/repos/alice/parser/patches/drafts/${id}`)
    await expect(page.getByRole("heading", { name: "Draft not found" })).toBeVisible()
    expect(await tuiPage(forker, backend, "/bobby/forks")).not.toContain("Document the parser")
    await owner.dispose()
    await forker.dispose()
  })

  test("a published patch's page leads to its fork, and back", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id } = await bobsFork(playwright, backend, hub.url)
    await apiWrite(forker, hub.url, "POST", `/api/v1/repos/alice/parser/patches/drafts/${id}/publish`)

    await page.goto(`${hub.url}/repos/alice/parser/patches/${id}`)
    await page.getByRole("region", { name: "Review" }).getByRole("link", { name: "Browse the fork" }).click()
    await expect(page).toHaveURL(`${hub.url}/forks/bobby/parser/${id}`)
    await expect(about(page)).toContainText("Published")
    await about(page).getByRole("link", { name: "Open the patch" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${id}`)
    await owner.dispose()
    await forker.dispose()
  })

  test("Haxy's own fork links open the fork's Hub pages", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, forker, id } = await bobsFork(playwright, backend, hub.url)
    await writeFile(path.join(backend.dataDir, "admin", "ABOUT.md"), [
      "# Fork links",
      "",
      `[fork](/bobby:parser+${id}) [diff](/bobby:parser+${id}/diff) [files](/bobby:parser+${id}/files) [commits](/bobby:parser+${id}/commits)`,
      `[delete](/bobby:parser+${id}/delete) [forks](/bobby/forks) [later forks](/bobby/forks/start:20) [named](/bobby:parser+${id}/files/object:${"a".repeat(40)}) [old commits](/bobby:parser+${id}/commits/object:${"a".repeat(40)})`,
    ].join("\n"))
    await page.goto(`${hub.url}/about`)

    const main = page.getByRole("main")
    const fork = `/forks/bobby/parser/${id}`
    await expect(main.getByRole("link", { name: "fork", exact: true })).toHaveAttribute("href", fork)
    await expect(main.getByRole("link", { name: "diff" })).toHaveAttribute("href", `${fork}/diff`)
    await expect(main.getByRole("link", { name: "files" })).toHaveAttribute("href", `${fork}/files`)
    await expect(main.getByRole("link", { name: "commits", exact: true })).toHaveAttribute("href", `${fork}/commits`)
    await expect(main.getByRole("link", { name: "delete" })).toHaveAttribute("href", `${fork}/delete`)
    await expect(main.getByRole("link", { name: "forks", exact: true })).toHaveAttribute("href", "/users/bobby")
    await expect(main.getByRole("link", { name: "later forks" })).toHaveAttribute("href", "/users/bobby")
    await expect(main.getByRole("link", { name: "named" })).toHaveAttribute("href", `/bobby:parser+${id}/files/object:${"a".repeat(40)}`)
    await expect(main.getByRole("link", { name: "old commits" })).toHaveAttribute("href", `/bobby:parser+${id}/commits/object:${"a".repeat(40)}`)

    await main.getByRole("link", { name: "diff" }).click()
    await expect(page.getByRole("heading", { name: "Changes in this fork" })).toBeVisible()
    await owner.dispose()
    await forker.dispose()
  })
})
