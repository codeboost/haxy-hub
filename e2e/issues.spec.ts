import { expect, test } from "./support/fixtures"
import { alice, registerUser } from "./support/accounts"
import { assignIssue, closeIssue, createIssue, setIssuesEnabled } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// Browser workflows for a repository's issues: open and closed lists with
// counts and pages, Haxy's search filters, the label listing and an issue's
// own page, against real Haxy fixtures through Vite's proxy.

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a reader pages through open issues and switches to closed ones; the URL keeps each view across refresh", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/linux`)

    await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Issues" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues`)
    const tabs = page.getByRole("navigation", { name: "Issue lists" })
    await expect(tabs.getByRole("link", { name: "Open 22" })).toHaveAttribute("aria-current", "page")
    await expect(tabs.getByRole("link", { name: "Closed 3" })).toBeVisible()
    const issues = page.getByRole("list", { name: "Open issues" })
    await expect(issues.getByRole("listitem")).toHaveCount(20)
    await expect(issues.getByRole("listitem").first().getByRole("link").first()).toHaveText("Deprecate the legacy plugin format")

    await page.getByRole("navigation", { name: "Issues pages" }).getByRole("link", { name: "Next page" }).click()
    await expect(page).toHaveURL(/\/repos\/bobby\/linux\/issues\?cursor=[0-9a-f]{32}$/)
    await expect(issues.getByRole("listitem")).toHaveCount(2)
    const secondPage = await issues.getByRole("listitem").allTextContents()
    await page.reload()
    await expect(page.getByRole("list", { name: "Open issues" }).getByRole("listitem")).toHaveCount(2)
    expect(await page.getByRole("list", { name: "Open issues" }).getByRole("listitem").allTextContents()).toEqual(secondPage)

    await page.getByRole("navigation", { name: "Issue lists" }).getByRole("link", { name: "Closed 3" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues/closed`)
    const closed = page.getByRole("list", { name: "Closed issues" })
    await expect(closed.getByRole("listitem")).toHaveCount(3)
    await expect(closed.getByRole("link", { name: "Memory leak when reconnecting after network failure" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("list", { name: "Closed issues" }).getByRole("listitem")).toHaveCount(3)
  })

  test("a reader narrows the issues with Haxy's label, assignee and text filters, kept in the URL", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/linux/issues`)

    const search = page.getByRole("searchbox", { name: "Search issues" })
    await search.fill("label:bug crash")
    await search.press("Enter")
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues?search=label%3Abug+crash`)
    await expect(page.getByRole("status", { name: "Active filters" })).toContainText("bug")
    const issues = page.getByRole("list", { name: "Open issues" })
    await expect(issues.getByRole("link", { name: "Crash on startup when config file is missing" })).toBeVisible()
    for (const row of await issues.getByRole("listitem").all()) await expect(row.getByRole("link", { name: "bug", exact: true })).toBeVisible()

    // the status tabs keep the search
    await page.getByRole("navigation", { name: "Issue lists" }).getByRole("link", { name: /^Closed/ }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues/closed?search=label%3Abug+crash`)
    await page.reload()
    await expect(page.getByRole("searchbox", { name: "Search issues" })).toHaveValue("label:bug crash")

    // a label in a row filters by it instead, keeping the words
    await page.goto(`${hub.url}/repos/bobby/linux/issues?search=${encodeURIComponent("label:bug crash")}`)
    await page.getByRole("list", { name: "Open issues" }).getByRole("listitem").first().getByRole("link", { name: "priority-high", exact: true }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues?search=label%3Apriority-high+crash`)
    const narrowed = page.getByRole("list", { name: "Open issues" })
    await expect(narrowed.getByRole("link", { name: "Crash on startup when config file is missing" })).toBeVisible()
    for (const row of await narrowed.getByRole("listitem").all()) await expect(row.getByRole("link", { name: "priority-high", exact: true })).toBeVisible()

    await page.goto(`${hub.url}/repos/bobby/linux/issues?search=${encodeURIComponent("assignee:alice")}`)
    await expect(page.getByRole("list", { name: "Open issues" }).getByRole("listitem")).toHaveText([/Deprecate the legacy plugin format/, /Timestamps display in UTC instead of local time/])

    await page.goto(`${hub.url}/repos/bobby/linux/issues?search=${encodeURIComponent("assignee:nobody-here")}`)
    await expect(page.getByText("No account is named nobody-here")).toBeVisible()
    await expect(page.getByRole("list", { name: "Open issues" })).toHaveCount(0)
  })

  test("the label listing links into the filtered issue list", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/linux/issues`)

    await page.getByRole("navigation", { name: "Issue lists" }).getByRole("link", { name: "Labels" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues/labels`)
    const labels = page.getByRole("list", { name: "Labels" })
    await expect(labels.getByRole("link", { name: "documentation", exact: true })).toBeVisible()
    await expect(page.getByRole("status", { name: "Label count" })).toHaveText(`${await labels.getByRole("listitem").count()} labels.`)
    await page.reload()
    await page.getByRole("list", { name: "Labels" }).getByRole("link", { name: "documentation", exact: true }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues?search=label%3Adocumentation`)
    await expect(page.getByRole("list", { name: "Open issues" }).getByRole("listitem")).toHaveText([/Add man pages for all subcommands/, /Document the plugin API/])
  })

  test("an issue's page shows its whole description, survives refresh and links to filtered lists", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/linux/issues?search=${encodeURIComponent("expired credentials")}`)

    await page.getByRole("link", { name: "Improve error message for expired credentials" }).click()
    await expect(page).toHaveURL(/\/repos\/bobby\/linux\/issues\/[0-9a-f]{32}$/)
    const url = page.url()
    await expect(page.getByRole("heading", { level: 2, name: "Improve error message for expired credentials" })).toBeVisible()
    await expect(page.getByText("Open", { exact: true })).toBeVisible()
    const description = page.getByRole("region", { name: "Description" })
    // the whole description, past the TUI list's preview
    const paragraphs = description.getByRole("paragraph")
    expect(await paragraphs.count()).toBeGreaterThan(3)
    const text = await description.textContent()

    await page.reload()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole("region", { name: "Description" })).toHaveText(text ?? "")

    await page.getByRole("region", { name: "Assignees" }).getByRole("link", { name: "admin" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/issues?search=assignee%3Aadmin`)
    await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Improve error message for expired credentials" })).toBeVisible()

    await page.goto(`${hub.url}/repos/bobby/linux/issues/${"0".repeat(32)}`)
    await expect(page.getByRole("heading", { name: "Issue not found" })).toBeVisible()
  })

  test("a private repository's issues look exactly like a missing repository to other viewers", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/neovim/issues`)
    await expect(page.getByRole("heading", { name: "Repository not found" })).toBeVisible()
    await expect(page.getByRole("list", { name: "Open issues" })).toHaveCount(0)
  })
})

test("a repository whose issues are turned off shows them as unavailable", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const repo = { owner: alice.name, name: "quiet", access: "public" as const }
  await createRepo(owner, backend, repo)
  await setIssuesEnabled(owner, backend, repo, false)
  await owner.dispose()

  await page.goto(`${hub.url}/repos/alice/quiet`)
  await expect(page.getByRole("heading", { level: 1, name: "quiet" })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Repository sections" }).getByText("Issues")).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/quiet/issues`)
  await expect(page.getByRole("heading", { level: 1, name: "quiet" })).toBeVisible()
  await expect(page.getByText("Issues are turned off for this repository.")).toBeVisible()
  await expect(page.getByRole("list", { name: "Open issues" })).toHaveCount(0)
})

test("local mode lists and shows the opened repository's issues, rendering their Markdown safely", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const hostile = await createIssue(request, backend, "", {
    title: "Hostile description",
    labels: "security",
    description: "<script>window.__pwned = 'script'</script>\n\n[run me](javascript:window.__pwned='link') and [the site](https://example.test/)\n",
  })
  const done = await createIssue(request, backend, "", { title: "Already done" })
  await closeIssue(request, backend, "", done)
  await assignIssue(request, backend, "", hostile, "dev@example.test")

  await page.goto(`${hub.url}/repo`)
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Issues" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues`)
  await expect(page.getByRole("navigation", { name: "Issue lists" }).getByRole("link", { name: "Closed 1" })).toBeVisible()
  await page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Hostile description" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/${hostile}`)
  await page.reload()

  const description = page.getByRole("region", { name: "Description" })
  await expect(description.getByRole("link", { name: "the site" })).toHaveAttribute("href", "https://example.test/")
  await expect(description.getByRole("link", { name: "run me" })).toHaveCount(0)
  await expect(description).toContainText("<script>")
  expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined()
  await expect(page.getByRole("region", { name: "Assignees" }).getByRole("link", { name: "dev@example.test" })).toBeVisible()

  await page.getByRole("link", { name: "security", exact: true }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues?search=label%3Asecurity`)
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("listitem")).toHaveCount(1)
})

test("Haxy's own issue links in a description open the matching Hub issue pages", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const target = await createIssue(owner, backend, "/alice:tracker", { title: "The target", labels: "bug" })
  const linker = await createIssue(owner, backend, "/alice:tracker", {
    title: "Links to Haxy pages",
    description: [
      `[issue](/alice:tracker/issue:${target})`,
      `[issue in a filtered list](/alice:tracker/issue:${target}/search:label%3Abug)`,
      `[description](/alice:tracker/issue:${target}/description)`,
      `[comment](/alice:tracker/issue:${target}/comment:${target})`,
      "[open](/alice:tracker/issues)",
      "[closed bugs](/alice:tracker/issues/closed/search:label%3Abug%20crash)",
      "[labels](/alice:tracker/issues/labels)",
      "[new issue](/alice:tracker/issues/new)",
      `[edit](/alice:tracker/issue:${target}/edit)`,
      `[remove](/alice:tracker/issue:${target}/remove)`,
    ].join("\n\n"),
  })
  await owner.dispose()

  await page.goto(`${hub.url}/repos/alice/tracker/issues/${linker}`)
  const description = page.getByRole("region", { name: "Description" })
  const href = (name: string) => description.getByRole("link", { name, exact: true })
  await expect(href("issue")).toHaveAttribute("href", `/repos/alice/tracker/issues/${target}`)
  await expect(href("issue in a filtered list")).toHaveAttribute("href", `/repos/alice/tracker/issues/${target}`)
  await expect(href("description")).toHaveAttribute("href", `/repos/alice/tracker/issues/${target}`)
  await expect(href("comment")).toHaveAttribute("href", `/repos/alice/tracker/issues/${target}/comments/${target}`)
  await expect(href("open")).toHaveAttribute("href", "/repos/alice/tracker/issues")
  await expect(href("closed bugs")).toHaveAttribute("href", "/repos/alice/tracker/issues/closed?search=label%3Abug+crash")
  await expect(href("labels")).toHaveAttribute("href", "/repos/alice/tracker/issues/labels")
  await expect(href("new issue")).toHaveAttribute("href", "/repos/alice/tracker/issues/new")
  await expect(href("edit")).toHaveAttribute("href", `/repos/alice/tracker/issues/${target}/edit`)
  // Hub has no page for Haxy's removal form, so that link stays as written
  await expect(href("remove")).toHaveAttribute("href", `/alice:tracker/issue:${target}/remove`)

  await href("issue").click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tracker/issues/${target}`)
  await expect(page.getByRole("heading", { level: 2, name: "The target" })).toBeVisible()
})

test("in local mode, Haxy's issue links (which leave out the repository) open the local issue pages", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const target = await createIssue(request, backend, "", { title: "The target" })
  const linker = await createIssue(request, backend, "", {
    title: "Links",
    description: `[issue](/issue:${target}) and [labels](/issues/labels/search:docs), [repository](/), [home](/home), [users](/home/users) and [someone](/alice)`,
  })

  await page.goto(`${hub.url}/repo/issues/${linker}`)
  const description = page.getByRole("region", { name: "Description" })
  await expect(description.getByRole("link", { name: "labels" })).toHaveAttribute("href", "/repo/issues/labels?search=docs")
  // local Haxy's root is the repository; it has no home, about or user pages, so those stay as written
  await expect(description.getByRole("link", { name: "repository" })).toHaveAttribute("href", "/repo")
  await expect(description.getByRole("link", { name: "home" })).toHaveAttribute("href", "/home")
  await expect(description.getByRole("link", { name: "users" })).toHaveAttribute("href", "/home/users")
  await expect(description.getByRole("link", { name: "someone" })).toHaveAttribute("href", "/alice")
  await description.getByRole("link", { name: "repository" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo`)
  await expect(page.getByRole("navigation", { name: "Repository sections" })).toBeVisible()
  await page.goBack()
  await description.getByRole("link", { name: "issue" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/issues/${target}`)
  await expect(page.getByRole("heading", { level: 2, name: "The target" })).toBeVisible()
})

test("turning issues off or on in another client shows on the next navigation, without a reload", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const repo = { owner: alice.name, name: "toggled", access: "public" as const }
  await createRepo(owner, backend, repo)
  await createIssue(owner, backend, "/alice:toggled", { title: "Kept while off" })
  await setIssuesEnabled(owner, backend, repo, false)

  await page.goto(`${hub.url}/repos/alice/toggled/issues`)
  await expect(page.getByText("Issues are turned off for this repository.")).toBeVisible()
  const sections = page.getByRole("navigation", { name: "Repository sections" })
  await sections.getByRole("link", { name: "Files" }).click()
  // the Files view shows (the router renders navigations as transitions)
  await expect(sections.getByRole("link", { name: "Files" })).toHaveAttribute("aria-current", "page")

  // on again, through Haxy's own settings form
  await setIssuesEnabled(owner, backend, repo, true)
  await page.goBack()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/toggled/issues`)
  await expect(page.getByRole("list", { name: "Open issues" }).getByRole("link", { name: "Kept while off" })).toBeVisible()
  await expect(sections.getByRole("link", { name: "Issues" })).toBeVisible()

  // and off again while the reader is elsewhere: the Issues link still offered leads to the notice
  await sections.getByRole("link", { name: "Files" }).click()
  await expect(sections.getByRole("link", { name: "Files" })).toHaveAttribute("aria-current", "page")
  await setIssuesEnabled(owner, backend, repo, false)
  await page.goBack()
  await expect(page.getByText("Issues are turned off for this repository.")).toBeVisible()
  await expect(page.getByRole("list", { name: "Open issues" })).toHaveCount(0)
  await expect(sections.getByRole("link", { name: "Issues" })).toHaveCount(0)
  await owner.dispose()
})

test("a label listing Haxy stopped counting says it is incomplete", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  // more labels than the TUI's labels view lists (1000), on one issue
  const labels = Array.from({ length: 1005 }, (_, index) => `l${String(index).padStart(4, "0")}`)
  await createIssue(request, backend, "", { title: "Many labels", labels: labels.join(" ") })
  await createIssue(request, backend, "", { title: "Few labels", labels: "alpha beta" })

  await page.goto(`${hub.url}/repo/issues/labels`)
  await expect(page.getByRole("list", { name: "Labels" }).getByRole("listitem")).toHaveCount(1000)
  await expect(page.getByRole("status", { name: "Label count" })).toHaveText(/at least 1,000 labels/i)
})
