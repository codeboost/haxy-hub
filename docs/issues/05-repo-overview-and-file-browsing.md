# #05 Repository overview and file browsing at the default branch

**Type:** AFK · **Status:** done · **User stories:** 27, 28, 29, 31, 32, 33

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

A reader opens a repository and sees its identity, description, available sections, and backend-provided clone/contribution commands (using the server's public transport config, not the frontend port). They browse directories at the default branch, navigate to parent paths, and view files with line numbers, linkable lines and content windows for large files. README and supported Markdown render safely (no unsafe HTML or URL schemes). Empty file, binary file, truncated content, and empty repository have distinct states. Works in local mode against the repository Zig opened.

## Acceptance criteria

- [x] Directory and file views at the default branch work for server and local mode fixtures
- [x] Line links (`#L…` or equivalent) and content windows survive refresh
- [x] README renders; a fixture with `<script>` / `javascript:` links does not execute
- [x] Empty repo, empty file, binary file and truncated file each show their specific state
- [x] Clone commands match the server's transport configuration and copy to clipboard
- [x] Private repo returns not-found for unauthorized viewers without disclosing existence
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`d1c324d` on `issue-05-repo-browse`)

## Blocked by

- [#02 Discovery: about page, user directory, and an owner's repositories](02-discovery-about-users-repos.md)

## Implementation notes

Backend: `haxy/src/api/repo.zig` (routes, unit tests in `src/test/api_repo.zig`). Handlers
build the same `ui.Session` as page loads and share the TUI's operations:
`ui.Repo.resolve` (repo lookup and visibility, extracted from `Repo.init`),
`ui.Repo.hasSection` (which tabs a viewer gets, now also used by `Repo.init`, its header
and view), `ui.widget.cloneCommands`/`remoteCommand` (extracted from the clone and
"no commits yet" widgets), and the files tab's `Files.listOrder`, `readFileContent`,
`isReadme` and `showsMarkdown`.

| Route | Response |
| --- | --- |
| `GET /api/v1/repos/{owner}/{name}` (server), `GET /api/v1/repo` (local) | `{"owner": string\|null, "name", "description", "access": "public"\|"private"\|null, "default_branch": string\|null, "empty": bool, "sections": Section[], "clone": GitCommand[], "remote": GitCommand\|null}` |
| `GET …/files?path=&cursor=&page_size=` on a directory | `{"ref", "path", "kind": "dir", "readme": {"name", "path"}\|null, "items": [{"name", "path", "kind": "dir"\|"file"}], "page"}` — directories first, then files, by name; count is exact; default page 1000 (the TUI's listing), `page_size` up to 100 |
| `GET …/files?path=&line=` on a file | `{"ref", "path", "name", "kind": "file", "content", "markdown": MarkdownBlock[]\|null}`; `content` is `{"kind": "text", "start_line", "lines", "total_lines", "has_more", "next_line"}`, `{"kind": "empty"}` or `{"kind": "binary"}` |

- `GitCommand` is `{"protocol": "http"\|"ssh", "url", "command"}`, built from the server's
  `web_url`/`ssh_url`/`git_ssh_prefix` (never the frontend's address). Only public repos
  clone over http; local mode has none. `remote` (`git remote add origin …`) is offered
  for an empty repo to viewers who may push, over ssh only, as in the TUI.
- `ref` is `{"kind": "branch"\|"tag"\|"commit", "name": string\|null, "commit": oid}`; it is
  always the default branch for now. #06 adds an optional `ref` query parameter to both
  routes (and to the Hub routes), so existing URLs keep meaning "the default branch".
- Every `path` (in responses and the `path` parameter) is percent-encoded bytes and every
  `name` is for display only, per "Repository paths" in the conventions
  (`src/api/path.zig`). Git allows paths that aren't UTF-8; the TUI can't show those (its
  text widgets fail with `InvalidUtf8`, so the files tab of such a directory doesn't
  render), which is a TUI issue left as is here.
- A file window is the TUI's: up to 5000 lines (fewer for very wide lines), starting at
  `line` (1-based). Lines are xit's, so a file ending in a newline has a last empty line,
  as in the TUI. `markdown` follows the TUI rule: a `.md`/`.markdown` file one first
  window holds whole, up to 2000 lines.
- A repo the viewer can't read, or doesn't exist, is `not_found` with the same message.
  A missing path is `not_found`; a repo without commits answers `files` with `not_found`
  ("This repository has no commits yet."), while the overview says `"empty": true`. A
  `line` that isn't a positive integer or lies beyond the file is `validation` (`line`).
- Each mode answers the other mode's routes with `unsupported` (405).

Haxy Hub: `src/lib/repo.ts`, `src/pages/RepoPage.tsx`, `src/components/RepoFiles.tsx`,
`src/components/GitCommands.tsx`. Routes `/repos/<owner>/<name>[/files/<path>]` and
`/repo[/files/<path>]`; `?cursor=` pages a directory, `?line=<n>` selects a file window,
`#L<n>` a line. README and Markdown files render from Haxy's parsed blocks (no HTML is
ever interpreted); their relative links resolve to repository paths as the TUI's files
tab resolves them, and only http(s)/mailto links leave the app. Sections other than
Files are listed but not linked until their slices land.

Not done here: mapping the TUI's `/<owner>:<name>[/files/…]` URLs in Markdown links to
Hub routes (`src/lib/haxyPaths.ts`) — left for #06, which documents the route mapping.
