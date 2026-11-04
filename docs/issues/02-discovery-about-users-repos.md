# #02 Discovery: about page, user directory, and an owner's repositories

**Type:** AFK · **Status:** done · **User stories:** 11, 12, 13, 100

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Anonymous visitors can read the forge's existing about information, search and paginate the user directory, open a user, and browse/search that owner's visible repositories. JSON endpoints reuse the existing queries behind the TUI's Home and User screens, honouring the same visibility rules (private repos never appear or leak via counts to unauthorized viewers). In local mode these server-only views are reported as unavailable rather than empty.

## Acceptance criteria

- [ ] About content matches what the TUI shows
- [ ] User directory search and pagination work and survive refresh/back/forward (filters and page in the URL)
- [ ] Owner page lists only repositories the viewer may read; a private repo is absent for anonymous and unrelated users (browser test + direct API check)
- [ ] Empty directory / no-match / no-repos states are distinct from load failures
- [ ] Local mode shows these views as unavailable
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#01 Foundation: acceptance harness, routed app shell, and API conventions](01-foundation-harness-and-app-shell.md)

## Implementation notes

Backend: `haxy/src/api/discovery.zig` (routes), `src/api/query.zig` (`search`, `cursor`,
`page_size`), `src/api/markdown.zig` (Markdown blocks as JSON). Handlers build the same
`ui.Session` as page loads and call the TUI's own data builders: `ui.Home.About.init`,
`ui.Home.Users.window` and `ui.User.readUser`/`ui.User.readRepos` (the last three
extracted from `Home/Users.zig` and `User.zig`, which now call them too).

| Route | Response |
| --- | --- |
| `GET /api/v1/about` | `{"title": string\|null, "blocks": MarkdownBlock[]}` — ABOUT.md parsed by Haxy's Markdown reader; a leading `# ` line becomes `title`, as in the TUI header |
| `GET /api/v1/users?search=&cursor=&page_size=` | page of `{"name"}`, by name; `search` is a name prefix |
| `GET /api/v1/users/{name}` | `{"name"}`, or `not_found` |
| `GET /api/v1/users/{name}/repos?search=&cursor=&page_size=` | page of `{"name","description","access":"public"\|"private"}` the viewer may read; newest activity first, by name when searching; `not_found` for an unknown user |

- Pages default to the TUI's window (20) and honour `page_size` up to 100. Counts are
  `unknown` (the TUI doesn't count; counting repos would reveal private ones).
- Repo pages are bounded by readable repos only (`ReposWindow.Bounds.readable`): a page
  holds up to `page_size` repos the viewer may read, its cursor points past the last one,
  and `has_more` is true only when another readable repo follows. Hidden repos therefore
  never change the number of pages or produce an empty later page. The TUI keeps its
  entry-bounded windows (`.entries`), whose "previous" row steps back by 20 entries. The
  user directory has no per-viewer filtering, so its pages need no such rule.
- Local mode answers `unsupported` (405) for all four; other methods get 405 with
  `Allow: GET, HEAD`.
- The viewer is the `haxy_session` cookie's user (no seeded auto-login claim), dropped if
  the account is gone, exactly as page loads do.

Haxy Hub routes and their TUI equivalents: `/` (TUI about tab) → `/about`;
`/home/users/search:<s>/start:<n>` → `/users?search=<s>&cursor=<opaque>`;
`/<name>[/repos/search:<s>]` → `/users/<name>[?search=<s>]`. User pages live under `/users/`
so user names can't collide with app routes. Markdown links to these Haxy paths (e.g. in
ABOUT.md) are translated by `src/lib/haxyPaths.ts`; other internal paths are kept as written. Repository rows are not links yet (#05).

Deferred: browser tests as a signed-in owner (the API test signs in through Haxy's
existing login form; the Hub's own login is #03).
