import { expect, test } from "./support/fixtures"
import { createRepo, signedIn } from "./support/repos"

// Browser workflows for a repository's overview and files at the default
// branch, against real Haxy fixtures through Vite's proxy.

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n") + "\n"
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xfe])

const hostileReadme = [
  "# Fixture",
  "",
  "<script>window.__pwned = 'script'</script>",
  "",
  "<img src=x onerror=\"window.__pwned = 'img'\">",
  "",
  "[run me](javascript:window.__pwned='link') [data](data:text/html,<script>alert(1)</script>) [the guide](docs/guide.md) [web](https://example.test/)",
  "",
].join("\n")

const fixtureFiles = {
  "README.md": hostileReadme,
  "docs/guide.md": "# Guide\n\nRead [the code](../src/main.zig).\n",
  "src/main.zig": "const std = @import(\"std\");\n\npub fn main() void {\n    std.debug.print(\"hi\\n\", .{});\n}\n",
  "empty.txt": "",
  "logo.png": png,
  "big.txt": numbered(6000),
}

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a reader opens a repository from its owner's page, browses into a directory, views a file and goes back up", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/users/bobby`)

    await page.getByRole("list", { name: "Repositories" }).getByRole("link", { name: "linux" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux`)
    await expect(page.getByRole("heading", { level: 1, name: "linux" })).toBeVisible()
    await expect(page.getByText("Linux kernel source tree")).toBeVisible()
    const sections = page.getByRole("navigation", { name: "Repository sections" })
    for (const name of ["Files", "Commits", "Refs", "Discussions", "Issues", "Patches"]) await expect(sections.getByText(name, { exact: true })).toBeVisible()
    await expect(sections.getByText("Events", { exact: true })).toHaveCount(0)

    // the root listing, with the README rendered beneath it
    const files = page.getByRole("list", { name: "Files" })
    await expect(files.getByRole("link")).toHaveText(["docs", "src", "README.md"])
    const readme = page.getByRole("region", { name: "README.md" })
    await expect(readme.getByRole("heading", { name: "Sample Repo" })).toBeVisible()
    await expect(readme.getByRole("link", { name: "an external site" })).toHaveAttribute("href", "https://github.com/xit-vcs/haxy")

    await files.getByRole("link", { name: "docs" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/files/docs`)
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "dev" }).click()
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "contribute.md" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/files/docs/dev/contribute.md`)
    await expect(page.getByRole("main")).toContainText("To contribute, please make a pull request")

    await page.reload()
    await expect(page.getByRole("main")).toContainText("To contribute, please make a pull request")

    // the path's breadcrumb leads back up, one directory or all the way
    const crumbs = page.getByRole("navigation", { name: "Path" })
    await crumbs.getByRole("link", { name: "docs" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/files/docs`)
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "dev" }).click()
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "Parent directory" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/files/docs`)
    await page.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "linux" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux`)
  })

  test("the clone commands come from the backend's transport settings and copy to the clipboard", async ({ page, context, launch }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/linux`)

    const clone = page.getByRole("region", { name: "Clone" })
    const http = `git clone http://localhost:${backend.port}/bobby:linux`
    await expect(clone.getByText(http)).toBeVisible()
    await expect(clone.getByText(/git clone ssh:\/\/localhost:\d+\/bobby:linux/)).toBeVisible()

    await clone.getByRole("button", { name: "Copy HTTP clone command" }).click()
    await expect(clone.getByRole("status")).toHaveText("Copied")
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(http)
  })

  test("a private repository looks exactly like a missing one to other viewers", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    await page.goto(`${hub.url}/repos/bobby/no-such-repo`)
    await expect(page.getByRole("heading", { level: 1, name: "Repository not found" })).toBeVisible()
    const missing = await page.getByRole("main").innerText()

    await page.goto(`${hub.url}/repos/bobby/neovim`)
    await expect(page.getByRole("heading", { level: 1, name: "Repository not found" })).toBeVisible()
    expect((await page.getByRole("main").innerText()).replaceAll("neovim", "no-such-repo")).toBe(missing)
    await page.goto(`${hub.url}/repos/bobby/neovim/files/README.md`)
    await expect(page.getByRole("heading", { level: 1, name: "Repository not found" })).toBeVisible()
  })

  test("an empty repository says so and offers its owner the remote command", async ({ playwright, page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    const bobby = await signedIn(playwright, backend, hub.url, "bobby", "password")
    await createRepo(bobby, backend, { name: "fresh", access: "public" })
    await bobby.dispose()

    await page.goto(`${hub.url}/login?next=${encodeURIComponent("/repos/bobby/fresh")}`)
    await page.getByLabel("Username").fill("bobby")
    await page.getByLabel("Password").fill("password")
    await page.getByRole("button", { name: "Log in" }).click()

    await expect(page).toHaveURL(`${hub.url}/repos/bobby/fresh`)
    await expect(page.getByRole("region", { name: "This repository is empty" })).toBeVisible()
    await expect(page.getByText(/git remote add origin ssh:\/\/localhost:\d+\/bobby:fresh/)).toBeVisible()
    await expect(page.getByRole("list", { name: "Files" })).toHaveCount(0)
  })
})

test("local mode browses the repository Haxy opened, from the main navigation", async ({ page, launch }) => {
  const backend = await launch.local({ files: fixtureFiles })
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Repository" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo`)
  await expect(page.getByRole("heading", { level: 1, name: "repo" })).toBeVisible()
  // local mode has no remote to clone from
  await expect(page.getByRole("region", { name: "Clone" })).toHaveCount(0)
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "src" }).click()
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "main.zig" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/src/main.zig`)
  await expect(page.getByRole("table", { name: "main.zig" })).toContainText("pub fn main() void {")
})

test("README Markdown renders without running scripts or unsafe links, and its relative links open repository files", async ({ page, launch }) => {
  const backend = await launch.local({ files: fixtureFiles })
  const hub = await launch.hub(backend.port)
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await page.goto(`${hub.url}/repo`)

  const readme = page.getByRole("region", { name: "README.md" })
  await expect(readme.getByRole("heading", { name: "Fixture" })).toBeVisible()
  // raw HTML shows as text and never becomes markup
  await expect(readme).toContainText("<script>window.__pwned = 'script'</script>")
  await expect(readme.locator("script, img, iframe")).toHaveCount(0)
  await expect(readme.getByRole("link", { name: "run me" })).toHaveCount(0)
  await expect(readme.getByRole("link", { name: "data" })).toHaveCount(0)
  await expect(page.locator("a[href^='javascript:'], a[href^='data:']")).toHaveCount(0)
  await expect(readme.getByRole("link", { name: "web" })).toHaveAttribute("href", "https://example.test/")
  await readme.getByText("run me").click()
  expect(await page.evaluate(() => (window as { __pwned?: string }).__pwned)).toBeUndefined()

  await readme.getByRole("link", { name: "the guide" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/docs/guide.md`)
  await expect(page.getByRole("heading", { name: "Guide", exact: true })).toBeVisible()
  await page.getByRole("link", { name: "the code" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/src/main.zig`)
  expect(dialogs).toEqual([])
  expect(await page.evaluate(() => (window as { __pwned?: string }).__pwned)).toBeUndefined()
})

test("a line link highlights its line and survives a refresh", async ({ page, launch }) => {
  const backend = await launch.local({ files: fixtureFiles })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/files/src/main.zig`)

  const code = page.getByRole("table", { name: "main.zig" })
  await code.getByRole("link", { name: "Line 3" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/src/main.zig#L3`)
  await expect(code.locator("tr[aria-current='location']")).toHaveText(/3\s*pub fn main\(\) void \{/)

  await page.reload()
  await expect(page.getByRole("table", { name: "main.zig" }).locator("tr[aria-current='location']")).toHaveText(/3\s*pub fn main\(\) void \{/)
})

test("a large file shows a window at a time; windows and line links in them survive a refresh", async ({ page, launch }) => {
  const backend = await launch.local({ files: fixtureFiles })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/files/big.txt`)

  const notice = page.getByRole("status", { name: "Partial content" })
  await expect(notice).toContainText("Showing lines 1–5,000 of 6,001")
  await notice.getByRole("link", { name: "Next lines" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/big.txt?line=5001`)
  await expect(page.getByRole("status", { name: "Partial content" })).toContainText("Showing lines 5,001–6,001 of 6,001")

  const code = page.getByRole("table", { name: "big.txt" })
  await code.getByRole("link", { name: "Line 5500" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/big.txt?line=5001#L5500`)
  await page.reload()
  const current = page.getByRole("table", { name: "big.txt" }).locator("tr[aria-current='location']")
  await expect(current).toHaveText(/5500\s*line 5500/)
  await expect(current).toBeInViewport()

  // a line outside the window offers to show the window that holds it
  await page.goto(`${hub.url}/repo/files/big.txt#L5500`)
  await page.getByRole("link", { name: "Show line 5500" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/big.txt?line=5500#L5500`)
  await expect(page.getByRole("table", { name: "big.txt" }).locator("tr[aria-current='location']")).toHaveText(/5500\s*line 5500/)

  await page.getByRole("status", { name: "Partial content" }).getByRole("link", { name: "First lines" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/big.txt`)
})

test("empty and binary files each say what they are", async ({ page, launch }) => {
  const backend = await launch.local({ files: fixtureFiles })
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo/files/empty.txt`)
  await expect(page.getByRole("region", { name: "This file is empty" })).toBeVisible()
  await page.goto(`${hub.url}/repo/files/logo.png`)
  await expect(page.getByRole("region", { name: "Binary file not shown" })).toBeVisible()
  await page.goto(`${hub.url}/repo/files/nowhere.txt`)
  await expect(page.getByRole("region", { name: "No such file or directory" })).toBeVisible()
})

test("a repository without commits shows the empty-repository state", async ({ page, launch }) => {
  const backend = await launch.local({ files: null })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo`)

  await expect(page.getByRole("region", { name: "This repository is empty" })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("each mode says when a repository route belongs to the other mode", async ({ page, launch }) => {
  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  await page.goto(`${localHub.url}/repos/alice/thing`)
  await expect(page.getByRole("main")).toContainText("Local mode serves only the repository Haxy opened")
  await page.getByRole("main").getByRole("link", { name: "Open the repository" }).click()
  await expect(page).toHaveURL(`${localHub.url}/repo`)

  const server = await launch.server()
  const serverHub = await launch.hub(server.port)
  await page.goto(`${serverHub.url}/repo`)
  await expect(page.getByRole("main")).toContainText("This server hosts many repositories")
})

test("files whose names hold percent escapes or aren't UTF-8 open from the listing and survive a refresh", async ({ page, launch }) => {
  const backend = await launch.local({
    files: { "a%2Fb.txt": "literal percent\n", "docs/x%41y.md": "# Escaped\n" },
    byteNamedFiles: [{ path: Uint8Array.from([...Buffer.from("caf"), 0xe9, ...Buffer.from(".txt")]), content: "latin-1 name\n" }],
  })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo`)

  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "a%2Fb.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/a%252Fb.txt`)
  await expect(page.getByRole("table", { name: "a%2Fb.txt" })).toContainText("literal percent")
  await page.reload()
  await expect(page.getByRole("table", { name: "a%2Fb.txt" })).toContainText("literal percent")

  await page.goto(`${hub.url}/repo`)
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "caf�.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/caf%E9.txt`)
  await expect(page.getByRole("table", { name: "caf�.txt" })).toContainText("latin-1 name")
  await page.reload()
  await expect(page.getByRole("table", { name: "caf�.txt" })).toContainText("latin-1 name")

  // a nested path keeps its escapes too, and its breadcrumb shows the names
  await page.goto(`${hub.url}/repo/files/docs/x%2541y.md`)
  await expect(page.getByRole("heading", { name: "Escaped" })).toBeVisible()
  await expect(page.getByRole("navigation", { name: "Path" })).toContainText("x%41y.md")
})

test("a directory's README too long for one window pages through its own file", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "docs/README": numbered(6000) } })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/files/docs`)

  const readme = page.getByRole("region", { name: "README" })
  await expect(readme.getByRole("status", { name: "Partial content" })).toContainText("Showing lines 1–5,000 of 6,001")
  await expect(readme.getByRole("link", { name: "Line 3", exact: true })).toHaveAttribute("href", "/repo/files/docs/README#L3")
  await readme.getByRole("link", { name: "Next lines" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/docs/README?line=5001`)
  await expect(page.getByRole("status", { name: "Partial content" })).toContainText("Showing lines 5,001–6,001 of 6,001")
})

for (const [label, dir, encoded] of [
  ["isn't UTF-8", [...Buffer.from("caf"), 0xe9], "caf%E9"],
  ["holds a percent escape", [...Buffer.from("x%41y")], "x%2541y"],
] as const) {
  test(`a long directory whose name ${label} pages forward and back to its first page`, async ({ page, launch }) => {
    // one more than a directory page holds
    const byteNamedFiles = Array.from({ length: 1001 }, (_, index) => ({
      path: Uint8Array.from([...dir, 0x2f, ...Buffer.from(`f${String(index).padStart(4, "0")}.txt`)]),
      content: "x\n",
    }))
    const backend = await launch.local({ files: { "README.md": "# Pages\n" }, byteNamedFiles })
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repo`)
    await page.getByRole("list", { name: "Files" }).getByRole("link").first().click()
    await expect(page).toHaveURL(`${hub.url}/repo/files/${encoded}`)

    const files = page.getByRole("list", { name: "Files" })
    await expect(files.getByRole("link", { name: "f0000.txt" })).toBeVisible()
    const pages = page.getByRole("navigation", { name: "Files pages" })
    await pages.getByRole("link", { name: "Next page" }).click()
    await expect(page).toHaveURL(new RegExp(`/repo/files/${encoded}\\?cursor=`))
    await expect(files.getByRole("link", { name: "f1000.txt" })).toBeVisible()

    await pages.getByRole("link", { name: "First page" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/files/${encoded}`)
    await expect(files.getByRole("link", { name: "f0000.txt" })).toBeVisible()
  })
}
