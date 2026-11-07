import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import type { Backend } from "./support/backend"
import { localGit } from "./support/history"
import { closePatch, createBranchPatch, divergeBranch } from "./support/patches"

// Browser workflows for a repository's patches: open, closed and merged
// lists with counts, Haxy's search and labels, a patch's own page, and
// review of its revision's diff, commits and files, against real Haxy
// fixtures through Vite's proxy. Every view is reloaded to check that its
// URL alone rebuilds it.

/** A local repository whose `feature` forked off `main` before `main` moved on, and whose `same` is `main` itself. */
async function divergedLocal(launch: { local(): Promise<Backend> }) {
  const backend = await launch.local()
  const git = localGit(backend)
  divergeBranch(git, "feature", [
    { message: "Add the parser", files: { "src/parser.txt": "parse\n" } },
    { message: "Test the parser", files: { "src/parser_test.txt": "test\n" } },
  ], [
    { message: "Only on main", files: { "main-only.txt": "the target moved on\n" } },
  ])
  git(["branch", "same", "main"])
  return backend
}

const proposal = (page: Page) => page.getByRole("region", { name: "Proposal" })

test("a reviewer opens a patch from its list and reviews its revision's diff, commits and files, each surviving a refresh", async ({ page, request, launch }) => {
  const backend = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const patch = await createBranchPatch(request, backend, "", { title: "Add a parser", labels: "parser", description: "Parses **things**.", source: "feature", target: "main" })
  await page.goto(`${hub.url}/repo`)

  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Patches" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches`)
  const tabs = page.getByRole("navigation", { name: "Patch lists" })
  await expect(tabs.getByRole("link", { name: "Open 1" })).toHaveAttribute("aria-current", "page")
  await expect(tabs.getByRole("link", { name: "Closed 0" })).toBeVisible()
  await expect(tabs.getByRole("link", { name: "Merged 0" })).toBeVisible()
  // local mode's owner may open patches (#18)
  await expect(page.getByRole("link", { name: "New patch" })).toBeVisible()
  await page.getByRole("list", { name: "Open patches" }).getByRole("link", { name: "Add a parser" }).click()

  await expect(page).toHaveURL(`${hub.url}/repo/patches/${patch}`)
  await expect(page.getByRole("heading", { name: "Add a parser" })).toBeVisible()
  await expect(proposal(page)).toContainText("Branch feature")
  await expect(proposal(page)).toContainText("Branch main")
  await expect(page.getByLabel("Commit count")).toHaveText("Commit count unavailable")
  await expect(page.getByLabel("Mergeability")).toContainText("Local mode doesn't merge patches")
  await expect(page.getByRole("status", { name: "No changes" })).toHaveCount(0)

  // the diff leaves out what the target had already, and lives in the URL
  const review = page.getByRole("navigation", { name: "Review this revision" })
  await review.getByRole("link", { name: "Diff" }).click()
  await expect(page).toHaveURL(new RegExp(`/repo/patches/revisions/([0-9a-f]{32})/diff\\?patch=${patch}$`))
  const revision = /revisions\/([0-9a-f]{32})\//.exec(page.url())![1]
  const diff = page.getByRole("region", { name: "Changes" })
  await expect(diff.getByRole("region")).toHaveCount(2)
  await expect(diff.getByRole("region", { name: "src/parser.txt" })).toContainText("Added")
  await expect(diff.getByRole("region", { name: "src/parser_test.txt" })).toBeVisible()
  await expect(diff.getByRole("region", { name: "main-only.txt" })).toHaveCount(0)
  await page.reload()
  await expect(diff.getByRole("region")).toHaveCount(2)
  await diff.getByRole("region", { name: "src/parser_test.txt" }).getByRole("link", { name: "Only this file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/revisions/${revision}/diff?patch=${patch}&path=src/parser_test.txt`)
  await page.reload()
  await expect(page.getByRole("status", { name: "Path filter" })).toContainText("src/parser_test.txt")
  await expect(diff.getByRole("region")).toHaveCount(1)
  // a file opens as the revision has it
  await diff.getByRole("region", { name: "src/parser_test.txt" }).getByRole("link", { name: "View file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/src/parser_test.txt?ref=revision:${revision}`)
  await page.goBack()
  await page.getByRole("link", { name: "Back to the patch" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${patch}`)

  // its commits run back to its base only
  await page.getByRole("navigation", { name: "Review this revision" }).getByRole("link", { name: "Commits" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits?ref=revision:${revision}`)
  const commits = page.getByRole("list", { name: "Commits" })
  await expect(commits.getByRole("listitem")).toHaveCount(2)
  await expect(commits).toContainText("Test the parser")
  await expect(commits).toContainText("Add the parser")
  await expect(commits).not.toContainText("Only on main")
  await expect(commits).not.toContainText("Initial commit")
  await page.reload()
  await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem")).toHaveCount(2)
  await page.goBack()

  // its files are its source commit's
  await page.getByRole("navigation", { name: "Review this revision" }).getByRole("link", { name: "Files" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=revision:${revision}`)
  await expect(page.getByRole("link", { name: "src", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "main-only.txt" })).toHaveCount(0)
})

test("a patch whose source is its target's tip says it changes nothing, and its diff is empty", async ({ page, request, launch }) => {
  const backend = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const patch = await createBranchPatch(request, backend, "", { title: "Nothing new", source: "same", target: "main" })
  await page.goto(`${hub.url}/repo/patches/${patch}`)
  await expect(page.getByRole("status", { name: "No changes" })).toContainText("already at this revision's source commit")
  await page.getByRole("navigation", { name: "Review this revision" }).getByRole("link", { name: "Diff" }).click()
  await expect(page.getByRole("region", { name: "No changes" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "No changes" })).toBeVisible()
})

test("a reader narrows patches with Haxy's search and labels, and finds closed ones in their own list", async ({ page, request, launch }) => {
  const backend = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  await createBranchPatch(request, backend, "", { title: "Add a parser", labels: "parser feature", source: "feature", target: "main" })
  await createBranchPatch(request, backend, "", { title: "Nothing new", labels: "noop", source: "same", target: "main" })
  const closed = await createBranchPatch(request, backend, "", { title: "Abandoned", labels: "feature", source: "same", target: "main" })
  await closePatch(request, backend, "", closed)
  await page.goto(`${hub.url}/repo/patches`)

  const search = page.getByRole("searchbox", { name: "Search patches" })
  await search.fill("label:feature")
  await search.press("Enter")
  await expect(page).toHaveURL(`${hub.url}/repo/patches?search=label%3Afeature`)
  await expect(page.getByRole("list", { name: "Open patches" }).getByRole("listitem")).toHaveText([/Add a parser/])
  await page.getByRole("navigation", { name: "Patch lists" }).getByRole("link", { name: "Closed 1" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/closed?search=label%3Afeature`)
  await expect(page.getByRole("list", { name: "Closed patches" }).getByRole("listitem")).toHaveText([/Abandoned/])
  await page.reload()
  await expect(page.getByRole("searchbox", { name: "Search patches" })).toHaveValue("label:feature")

  await page.getByRole("navigation", { name: "Patch lists" }).getByRole("link", { name: "Labels" }).click()
  await page.getByRole("list", { name: "Labels" }).getByRole("link", { name: "noop" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches?search=label%3Anoop`)
  await expect(page.getByRole("list", { name: "Open patches" }).getByRole("listitem")).toHaveText([/Nothing new/])
})

test("a comment posted on a patch persists after a refresh and shows on Haxy's own patch page", async ({ page, request, launch }) => {
  const backend = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const patch = await createBranchPatch(request, backend, "", { title: "Add a parser", source: "feature", target: "main" })
  await page.goto(`${hub.url}/repo/patches/${patch}`)

  await page.getByRole("form", { name: "New comment" }).getByLabel("New comment").fill("Looks right to me")
  await page.getByRole("form", { name: "New comment" }).getByRole("button", { name: "Comment" }).click()
  await expect(page.getByRole("article", { name: /^Comment by / }).filter({ hasText: "Looks right to me" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("list", { name: "Comments" }).getByRole("article")).toHaveText([/Looks right to me/])
  await expect(page.getByText("1 comment", { exact: true })).toBeVisible()
  const html = await (await request.get(`${backend.origin}/patch:${patch}`)).text()
  expect(html).toContain("Looks right to me")
})

test("a Haxy link to a patch, its comment or its revision diff opens the matching Hub page", async ({ page, request, launch }) => {
  const backend = await divergedLocal(launch)
  const hub = await launch.hub(backend.port)
  const patch = await createBranchPatch(request, backend, "", {
    title: "Add a parser",
    source: "feature",
    target: "main",
  })
  const detail = await (await request.get(`${hub.url}/api/v1/repo/patches/${patch}`)).json()
  const revision = detail.revision.id
  const linking = await createBranchPatch(request, backend, "", {
    title: "Links",
    source: "same",
    target: "main",
    description: `See [the parser](/patch:${patch}), [its diff](/diff/patchrev:${revision}/path:src/parser.txt) and [merged ones](/patches/merged).`,
  })
  await page.goto(`${hub.url}/repo/patches/${linking}`)
  await page.getByRole("link", { name: "the parser" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${patch}`)
  await page.goBack()
  await page.getByRole("link", { name: "its diff" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/revisions/${revision}/diff?path=src/parser.txt`)
  await expect(page.getByRole("region", { name: "Changes" }).getByRole("region")).toHaveCount(1)
  await page.goBack()
  await page.getByRole("link", { name: "merged ones" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/merged`)
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a merged patch is listed with its status and reviewed at what landed; a forked one is reviewed in its fork", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/admin/toolbox/patches`)
    await page.getByRole("navigation", { name: "Patch lists" }).getByRole("link", { name: /^Merged/ }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/admin/toolbox/patches/merged`)
    await page.getByRole("list", { name: "Merged patches" }).getByRole("link", { name: /legacy configuration loader$/ }).click()
    await expect(page.getByLabel("Status")).toHaveText("Merged")
    await expect(proposal(page)).toContainText("With its source commits")
    await expect(proposal(page)).toContainText("Branch master")
    await page.getByRole("navigation", { name: "Review this revision" }).getByRole("link", { name: "What landed" }).click()
    await expect(page).toHaveURL(/\/repos\/admin\/toolbox\/patches\/revisions\/[0-9a-f]{32}\/diff\?patch=[0-9a-f]{32}$/)
    await expect(page.getByRole("region", { name: "Changes" }).getByRole("region", { name: "patch.txt" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("region", { name: "Changes" }).getByRole("region", { name: "patch.txt" })).toBeVisible()

    await page.goto(`${hub.url}/repos/admin/toolbox/patches`)
    await page.getByRole("list", { name: "Open patches" }).getByRole("link", { name: "Add structured output to the inspect command" }).click()
    await expect(proposal(page)).toContainText("The fork admin/toolbox")
    await page.getByRole("navigation", { name: "Review in its fork" }).getByRole("link", { name: "Browse the fork" }).click()
    await expect(page).toHaveURL(new RegExp(`${hub.url}/forks/admin/toolbox/[0-9a-f]{32}$`))
    await expect(page.getByRole("heading", { level: 1, name: "Add structured output to the inspect command" })).toBeVisible()
  })
})
