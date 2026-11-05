import { writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "./support/fixtures"
import { alice } from "./support/accounts"
import { indexedServer, serveLocally, serverRepoDirs } from "./support/finder"
import { createIssue } from "./support/issues"
import { signedIn } from "./support/repos"

// Browser workflows for the file finder, against repositories Haxy indexed
// on push, through Vite's proxy. The ref, search and page live in the URL; a
// result opens the file at the same ref.

test("finding a file from the ref bar opens it at the same branch, and the search survives refresh and back", async ({ page, playwright, launch }) => {
  const { hub } = await indexedServer(playwright, launch)
  await page.goto(`${hub.url}/repos/alice/tricky?ref=branch:feature`)

  await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "Find a file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find?ref=branch:feature`)
  await expect(page.getByText("Finding files at branch feature")).toBeVisible()
  await expect(page.getByText("Type the start of a file name.")).toBeVisible()

  await page.getByRole("searchbox", { name: "Find files by name" }).fill("read")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find?ref=branch:feature&search=read`)
  const results = page.getByRole("list", { name: "Found files" })
  await expect(results.getByRole("link")).toHaveText(["Read Me.mddocs/sub dir", "README.md"])
  await expect(page.getByRole("status", { name: "Result count" })).toHaveText("2 files match.")

  await page.reload()
  await expect(results.getByRole("link")).toHaveCount(2)
  await expect(page.getByRole("searchbox", { name: "Find files by name" })).toHaveValue("read")

  await results.getByRole("link", { name: /Read Me\.md/ }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/docs/sub%20dir/Read%20Me.md?ref=branch:feature`)
  await expect(page.getByRole("heading", { name: "Nested read me" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Branch feature")

  await page.goBack()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find?ref=branch:feature&search=read`)
  await expect(results.getByRole("link")).toHaveCount(2)

  // the branch's own file, found only on it
  await page.getByRole("searchbox", { name: "Find files by name" }).fill("feat")
  await page.getByRole("button", { name: "Search" }).click()
  await results.getByRole("link", { name: /feature only\.txt/ }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/feature%20only.txt?ref=branch:feature`)
  await expect(page.getByRole("table", { name: "feature only.txt" })).toContainText("only on feature")
})

test("names with literal escapes, Unicode, bytes that aren't UTF-8 and leading spaces are found and opened exactly", async ({ page, playwright, launch }) => {
  const { hub } = await indexedServer(playwright, launch)
  const box = page.getByRole("searchbox", { name: "Find files by name" })
  const results = page.getByRole("list", { name: "Found files" })
  const search = async (term: string) => {
    await box.fill(term)
    await page.getByRole("button", { name: "Search" }).click()
  }
  await page.goto(`${hub.url}/repos/alice/tricky/find`)

  await search("a%4")
  await expect(results.getByRole("link")).toHaveText(["a%41.txt"])
  await results.getByRole("link", { name: "a%41.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/a%2541.txt`)
  await expect(page.getByRole("table", { name: "a%41.txt" })).toContainText("literal percent 41")
  await page.goBack()

  await search("a%2F")
  await results.getByRole("link", { name: "a%2Fb.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/a%252Fb.txt`)
  await expect(page.getByRole("table", { name: "a%2Fb.txt" })).toContainText("literal percent 2F")
  await page.goBack()

  await search("caf")
  await expect(results.getByRole("link")).toHaveText(["Café.mdsrc", "café.txt", "caf�.bin"])
  await results.getByRole("link", { name: "caf�.bin" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/caf%E9.bin`)
  await expect(page.getByRole("table", { name: "caf\uFFFD.bin" })).toContainText("latin-1 name")
  await page.goBack()
  await results.getByRole("link", { name: /Café\.md/ }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/src/Caf%C3%A9.md`)
  await expect(page.getByRole("heading", { name: "Upper case" })).toBeVisible()

  // typed as is: the leading space is part of the search
  await page.goto(`${hub.url}/repos/alice/tricky/find`)
  await search(" le")
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find?search=+le`)
  await results.getByRole("link", { name: "lead.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/files/%20lead.txt`)
  await expect(page.getByRole("table", { name: "lead.txt" })).toContainText("leading space")
})

test("no index, an unsupported ref and no matches each say so, never as an empty list", async ({ page, playwright, launch }) => {
  const { server, hub } = await indexedServer(playwright, launch)
  const context = await signedIn(playwright, server, hub.url, alice.name, alice.password)
  await createIssue(context, server, "/alice:tricky", { title: "Start the events branch" })
  const results = page.getByRole("list", { name: "Found files" })
  const box = page.getByRole("searchbox", { name: "Find files by name" })

  await page.goto(`${hub.url}/repos/alice/tricky/find?search=zzz`)
  await expect(page.getByRole("region", { name: "No files match “zzz”" })).toBeVisible()
  await expect(results).toHaveCount(0)
  await expect(box).toHaveValue("zzz")

  // from a tag's files, as from any ref
  await page.goto(`${hub.url}/repos/alice/tricky?ref=tag:v1`)
  await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "Find a file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find?ref=tag:v1`)
  const unsupported = page.getByRole("region", { name: "Files can't be found by name at a tag" })
  await expect(unsupported).toContainText("Haxy indexes branches only.")
  await expect(box).toHaveCount(0)
  await unsupported.getByRole("link", { name: "find files on the default branch" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find`)
  await expect(box).toBeVisible()

  await page.goto(`${hub.url}/repos/alice/tricky/find?ref=branch:haxy/events&search=read`)
  const missing = page.getByRole("region", { name: "This branch has no file index" })
  await expect(missing).toContainText("haxy/events")
  await expect(results).toHaveCount(0)
  await expect(box).toHaveCount(0)
  await missing.getByRole("link", { name: "Browse its files" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky?ref=branch:haxy/events`)

  await page.goto(`${hub.url}/repos/alice/tricky/find?ref=branch:nope`)
  await expect(page.getByRole("region", { name: "Nothing here at this ref" })).toContainText("no such branch")
})

test("more matches than the finder lists show as a lower bound", async ({ page, playwright, launch }) => {
  const { hub } = await indexedServer(playwright, launch)
  await page.goto(`${hub.url}/repos/alice/tricky/find?search=f`)
  await expect(page.getByRole("status", { name: "Result count" })).toHaveText("1,000+ files match; Haxy lists the first 1,000. Type more of the name to narrow them.")
  await expect(page.getByRole("list", { name: "Found files" }).getByRole("link")).toHaveCount(1000)
})

test("local mode finds files in an indexed xit repository, and says a git repository has no index", async ({ page, playwright, launch }) => {
  const git = await launch.local()
  const gitHub = await launch.hub(git.port)
  await page.goto(`${gitHub.url}/repo`)
  await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "Find a file" }).click()
  await expect(page).toHaveURL(`${gitHub.url}/repo/find`)
  await expect(page.getByRole("region", { name: "This repository can't be searched by file name" })).toContainText("this is a Git repository")

  const { server } = await indexedServer(playwright, launch)
  const [dir] = serverRepoDirs(server)
  await server.stop()
  const local = await serveLocally(dir)
  const hub = await launch.hub(local.port)
  await page.goto(`${hub.url}/repo/find?ref=branch:feature`)
  await page.getByRole("searchbox", { name: "Find files by name" }).fill("a%2")
  await page.getByRole("button", { name: "Search" }).click()
  await page.getByRole("list", { name: "Found files" }).getByRole("link", { name: "a%2Fb.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/a%252Fb.txt?ref=branch:feature`)
  await expect(page.getByRole("table", { name: "a%2Fb.txt" })).toContainText("literal percent 2F")
})

test("Haxy's own finder links open the Hub finder, or the result they chose", async ({ page, playwright, launch }) => {
  const { server, hub } = await indexedServer(playwright, launch)
  await writeFile(path.join(server.dataDir, "admin", "ABOUT.md"), [
    "# Finder links",
    "",
    "[search](/alice:tricky/files/branch:feature/find:read) [default](/alice:tricky/files/find:a%25)",
    "[chosen](/alice:tricky/files/find:read/line:1/branch:main/path:docs/sub%20dir/Read%20Me.md) [tagged](/alice:tricky/files/tag:v1/find:x)",
  ].join("\n"))
  await page.goto(`${hub.url}/about`)

  const main = page.getByRole("main")
  await expect(main.getByRole("link", { name: "search" })).toHaveAttribute("href", "/repos/alice/tricky/find?ref=branch:feature&search=read")
  await expect(main.getByRole("link", { name: "default" })).toHaveAttribute("href", "/repos/alice/tricky/find?search=a%25")
  await expect(main.getByRole("link", { name: "chosen" })).toHaveAttribute("href", "/repos/alice/tricky/files/docs/sub%20dir/Read%20Me.md?ref=branch:main")
  await expect(main.getByRole("link", { name: "tagged" })).toHaveAttribute("href", "/repos/alice/tricky/find?ref=tag:v1&search=x")

  await main.getByRole("link", { name: "default" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/tricky/find?search=a%25`)
  await expect(page.getByRole("list", { name: "Found files" }).getByRole("link")).toHaveText(["a%2Fb.txt", "a%41.txt"])
})
