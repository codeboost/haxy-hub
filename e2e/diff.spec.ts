import { expect, test } from "./support/fixtures"
import { addCommits, localGit } from "./support/history"

// Browser workflows for a commit's diff, against real Haxy fixtures through
// Vite's proxy.

const latin1Name = Uint8Array.from([...Buffer.from("caf"), 0xe9, ...Buffer.from(".txt")])

test("a reader opens a commit's diff, pages through it, narrows it to one file and opens the commit's files", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "notes.txt": "one\ntwo\nthree\n", "logo.png": Uint8Array.from([0x89, 0x50, 0xff, 0]) } })
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const files: Record<string, string | Uint8Array> = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`file-${String(index).padStart(2, "0")}.txt`, "added\n"]))
  const [head] = addCommits(git, [{
    message: "Rework the notes",
    files: { ...files, "notes.txt": "one\n2\nthree\n", "logo.png": Uint8Array.from([0x89, 0x50, 0xfe, 0]) },
  }])
  await page.goto(`${hub.url}/repo/commits/${head}`)

  await page.getByRole("link", { name: "View changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits/${head}/diff`)
  const diff = page.getByRole("region", { name: "Changes" })
  // ten entries a window, in the order of Haxy's tree diff: changed files, then added ones
  await expect(diff.getByRole("region")).toHaveCount(10)
  await expect(diff.getByRole("region", { name: "logo.png" })).toContainText("Binary file")
  const notes = diff.getByRole("region", { name: "notes.txt" })
  await expect(notes.getByRole("row", { name: "Removed, line 2: two" })).toBeVisible()
  await expect(notes.getByRole("row", { name: "Added, line 2: 2" })).toBeVisible()
  await expect(notes.getByRole("row", { name: "Line 3: three" })).toBeVisible()
  await expect(diff.getByRole("region", { name: "file-00.txt" })).toContainText("Added")
  await expect(diff.getByRole("region", { name: "file-08.txt" })).toHaveCount(0)

  // the next window is in the URL, survives a refresh, and back returns
  await page.getByRole("navigation", { name: "Diff pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp(`/repo/commits/${head}/diff\\?cursor=\\w+$`))
  await page.reload()
  await expect(diff.getByRole("region")).toHaveCount(2)
  await expect(diff.getByRole("region", { name: "file-09.txt" })).toContainText("Added")
  await expect(page.getByRole("navigation", { name: "Diff pages" }).getByRole("link", { name: "Next page" })).toHaveCount(0)
  await page.goBack()
  await expect(notes).toBeVisible()

  // one file's changes, kept in the URL
  await notes.getByRole("link", { name: "Only this file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits/${head}/diff?path=notes.txt`)
  await page.reload()
  await expect(page.getByRole("status", { name: "Path filter" })).toContainText("notes.txt")
  await expect(diff.getByRole("region")).toHaveCount(1)
  await expect(diff.getByRole("region", { name: "notes.txt" })).toBeVisible()

  // the file as the commit left it
  await diff.getByRole("region", { name: "notes.txt" }).getByRole("link", { name: "View file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/notes.txt?ref=commit:${head}`)
  await page.goBack()
  await page.getByRole("status", { name: "Path filter" }).getByRole("link", { name: "Show all files" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits/${head}/diff`)

  // and the commit's whole tree
  await page.getByRole("link", { name: "Browse files at this commit" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=commit:${head}`)
  await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Commit ${head}`)
})

test("a path that isn't UTF-8 narrows the diff through links, refresh and back", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "README.md": "# fixture\n" }, byteNamedFiles: [{ path: latin1Name, content: "latin-1\n" }] })
  const hub = await launch.hub(backend.port)
  const root = localGit(backend)(["rev-parse", "HEAD"])
  await page.goto(`${hub.url}/repo/commits/${root}/diff`)
  const diff = page.getByRole("region", { name: "Changes" })
  const odd = diff.getByRole("region", { name: "caf�.txt" })
  await expect(odd).toContainText("Added")
  await odd.getByRole("link", { name: "Only this file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits/${root}/diff?path=caf%E9.txt`)
  await page.reload()
  await expect(diff.getByRole("region")).toHaveCount(1)
  await expect(diff.getByRole("region", { name: "caf�.txt" })).toBeVisible()
  await diff.getByRole("region", { name: "caf�.txt" }).getByRole("link", { name: "View file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/caf%E9.txt?ref=commit:${root}`)
  await page.goBack()
  await expect(page).toHaveURL(`${hub.url}/repo/commits/${root}/diff?path=caf%E9.txt`)
  await expect(diff.getByRole("region")).toHaveCount(1)
})

test("a removed file opens as its parent had it, and a commit without changes says so", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "gone.txt": "bye\n", "kept.txt": "kept\n" } })
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const root = git(["rev-parse", "HEAD"])
  git(["rm", "--quiet", "--cached", "gone.txt"])
  const [removal, empty] = addCommits(git, [{ message: "Remove gone.txt" }, { message: "Nothing" }])
  await page.goto(`${hub.url}/repo/commits/${removal}/diff`)
  const gone = page.getByRole("region", { name: "Changes" }).getByRole("region", { name: "gone.txt" })
  await expect(gone).toContainText("Removed")
  await gone.getByRole("link", { name: "View file" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/gone.txt?ref=commit:${root}`)

  await page.goto(`${hub.url}/repo/commits/${empty}/diff`)
  await expect(page.getByRole("region", { name: "No changes" })).toBeVisible()
  await page.goto(`${hub.url}/repo/commits/${removal}/diff?path=kept.txt`)
  await expect(page.getByRole("region", { name: "No changes to this file" })).toBeVisible()
  await page.goto(`${hub.url}/repo/commits/${"0".repeat(40)}/diff`)
  await expect(page.getByRole("region", { name: "No such commit" })).toBeVisible()
})

test("long lines scroll inside their diff on a narrow screen, not the page", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "wide.txt": "short\n" } })
  const hub = await launch.hub(backend.port)
  const [head] = addCommits(localGit(backend), [{ message: "Widen", files: { "wide.txt": `${"wide ".repeat(800)}end\n` } }])
  await page.setViewportSize({ width: 360, height: 720 })
  await page.goto(`${hub.url}/repo/commits/${head}/diff`)
  const lines = page.getByRole("table", { name: "Changes to wide.txt" })
  await expect(lines).toContainText("end")
  const sizes = await lines.evaluate((table) => {
    const scroller = table.parentElement as HTMLElement
    return {
      scroll: scroller.scrollWidth, client: scroller.clientWidth, right: scroller.getBoundingClientRect().right,
      page: document.documentElement.scrollWidth, viewport: window.innerWidth,
    }
  })
  // the diff overflows its own container, which scrolls; the page doesn't
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  expect(sizes.right).toBeLessThanOrEqual(sizes.viewport)
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport)
})

test("a diff Haxy couldn't read to the end never claims a commit changes nothing", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "kept.txt": "kept\n" } })
  const hub = await launch.hub(backend.port)
  const [head] = addCommits(localGit(backend), [{ message: "Change", files: { "kept.txt": "changed\n" } }])
  // a diff past xit's 50 million lines can't be built here, so Haxy's real
  // answer is cut short as it would be: the limit hit before any entry
  await page.route("**/api/v1/repo/commits/*/diff*", async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), items: [], truncated: true } })
  })
  for (const query of ["", "?path=kept.txt", "?cursor=5"]) {
    await page.goto(`${hub.url}/repo/commits/${head}/diff${query}`)
    await expect(page.getByRole("region", { name: "These changes are incomplete" }), query).toBeVisible()
    await expect(page.getByRole("region", { name: /^No (more )?changes/ }), query).toHaveCount(0)
  }
})
