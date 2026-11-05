# Haxy Hub

React + TypeScript, Vite, Tailwind CSS v4, and shadcn/ui with Radix primitives.
Vite serves the UI and proxies `/api/*` to Zig. There is no separate Express
server, no browser CORS setup, and no forge logic in Node.

This frontend lives in `haxy-hub/`, alongside the backend's `haxy/` repository.

## Start locally (two processes)

Haxy (Zig) and Haxy Hub (Vite) run as two independent processes. Start the backend
first, from the sibling `haxy/` repository (Zig 0.17):

```sh
# a multi-user server with demo data (web on :8080, SSH on :8022)
zig build try
# or your own server
zig build && ./zig-out/bin/haxy serve --data-dir ../haxy-data
# or local mode, inside any git or xit repository
/path/to/haxy                                           # TUI + web UI on :8080 (or a free port)
/path/to/haxy --no-tui --web-listen 127.0.0.1:8080      # web UI only, exactly that address
```

Then, in a second terminal:

```sh
cd haxy-hub
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The header shows whether Haxy is in **server** or **local**
mode. If Haxy is down, or is an older build without the status API, the page says so
(*Can't reach Haxy* / *Incompatible Haxy backend*) and offers **Retry**. Routes are
client-side (`/`, `/connection`, `/login`, `/register`, `/account`, `/about`, `/users`,
`/users/<name>`, `/repos/<owner>/<name>[/files/<path>]` and
`/repos/<owner>/<name>/branches|tags|find` and `/repos/<owner>/<name>/commits[/<id>]` on a
server, `/repo[/files/<path>]`, `/repo/branches|tags|find` and `/repo/commits[/<id>]` in local
mode; anything else is *Page not found*); refreshing any
URL reconstructs the same view, because Vite serves `index.html` for unknown paths. List
searches and pages live in the query string (`?search=…&cursor=…`), the ref a files view
is read at in `?ref=<id>` (`branch:<name>`, `tag:<name>`, `commit:<oid>` or
`revision:<id>`; the default branch without one), a large file's window in `?line=<n>`
and a selected line in `#L<n>`. Haxy's own page URLs in Markdown (such as
`/<owner>:<name>/files/branch:<name>/path:<path>`) are translated to these routes; the
full mapping is in `src/lib/haxyPaths.ts`. Repository paths and ref names in these URLs are Haxy's
percent-encoded bytes and may not be UTF-8 (e.g. `/repo/files/caf%E9.txt?ref=branch:caf%E9`); Vite's dev and
preview servers serve the app for them too (`vite.config.ts`), and a production host's
fallback must not reject URLs that don't decode as UTF-8. The about and user pages exist
only in server mode; local mode shows them as unavailable.
In server mode the header shows who is signed in, with **Log in** (`/login`, which
returns to the page you came from) and **Register** (`/register`), or **Log out**; local
mode has no accounts and no login UI. `/account` (the signed-in name links there) changes
the email and password, manages SSH keys, and deletes the account. The session is Haxy's
own HttpOnly cookie, shared with Haxy's browser-rendered UI.
Repositories can be browsed at their default branch or any branch, tag, commit or patch
revision, with the commit history at any of them (searchable where Haxy has a commit
index, i.e. on a server) and each commit's whole message; patch screens are not
implemented yet.

The backend defaults to http://127.0.0.1:8080. To change it, copy `.env.example` to
`.env.local`, edit `HAXY_BACKEND_URL`, and restart Vite. Alternatively:

```sh
HAXY_BACKEND_URL=http://127.0.0.1:9090 npm run dev
```

The backend setting stays in the Node process; browser requests always use relative
`/api/` URLs. Paths and query strings are forwarded unchanged, along with cookies.
Vite preserves Host and Origin, and its own CORS handling is off (`cors: false`). Zig
checks the Origin and a CSRF token on every state-changing `/api/` request (see Security
notes in the conventions); write endpoints must still authorize in Zig.

## API

The JSON API conventions (error envelope, pagination, IDs, timestamps, capabilities,
timeouts) are in [docs/api-conventions.md](docs/api-conventions.md) — currently a
**draft awaiting review**. `src/lib/api.ts` holds the matching TypeScript types and the
`requestJson`/`getJson` client; Zig's counterpart is `haxy/src/api.zig`.

`GET /api/v1/status` (also HEAD) returns:

```json
{ "service": "haxy", "api_version": 1, "mode": "server" }
```

Mode is `local` or `server`. This checks HTTP connectivity, not repository health.
Unknown API paths return the JSON `not_found` error envelope; other methods on the status
route return `unsupported` (405, with `Allow: GET, HEAD`). An older Zig binary without
this route is reported as incompatible, not connected. The status check has a ten-second
timeout; other requests use their own (see the conventions).

## Acceptance tests

```sh
npm run test:e2e
```

This runs Playwright (Chromium) against real Haxy processes through Vite's proxy:

1. **Build/select the backend** (once per run, `e2e/global-setup.ts`): runs
   `zig build install try-install` in `../haxy`, installing into
   `node_modules/.cache/haxy-e2e/zig-out` so the checkout's own `zig-out` is untouched.
   The first build takes a few minutes; later runs reuse Zig's cache.
2. **Start isolated fixtures per test** (`e2e/support/`): every backend gets a fresh
   `$TMPDIR/haxy-hub-e2e-*` sandbox as its cwd, with its own `HOME` and git config, and a
   free port (never 8080/8022). Fixtures:
   - `launch.server()` — `haxy serve` on an empty data dir that Haxy initialises itself;
     `backend.restart()` restarts it on the same port and data dir. Register users with
     `registerUser(backend, account)` (`e2e/support/accounts.ts`), which posts Haxy's own
     sign-up form; `writeHeaders(request, hub.url)` gives an API request context a CSRF
     token for HTTP contract tests. `launch.server({ ssh: true })` also serves SSH, and
     `pushRepo(…)` (`e2e/support/push.ts`) pushes a fixture repository to it over SSH as a
     user, Haxy's only way in for commits, which also builds its commit and file indexes;
   - `launch.demo()` — the `zig build try` demo data (users, repos, issues, patches),
     seeded by Haxy's own event utilities via `try --cli`, inside the sandbox;
   - `launch.local()` — local mode (`haxy --no-tui --web-listen …`) in a fresh git repo;
   - `launch.incompatible(…)` — a small HTTP stand-in for a backend Haxy Hub must
     reject (the only fake; the real binary is compatible by definition);
   - `launch.hub(port)` — a Vite dev server on a free port with `HAXY_BACKEND_URL`
     pointing at that backend port (which may not be listening yet, to test outages).
3. **Tear down** every process and delete its sandbox after each test.

Nothing touches `../haxy-data`, `temp-try`, `.env.local`, or a running developer session.

| Variable | Effect |
| --- | --- |
| `HAXY_REPO` | Haxy checkout to build (default `../haxy`). |
| `HAXY_BIN` | Use this prebuilt `haxy` instead of building. |
| `HAXY_TRY_BIN` | Prebuilt `try` for the demo fixture (with `HAXY_BIN`; otherwise demo tests are skipped). |
| `HAXY_E2E_SKIP_BUILD=1` | Reuse the binaries from the last build. |
| `ZIG` | Zig executable (default `zig`). |
| `HAXY_E2E_KEEP=1` | Keep sandboxes in `$TMPDIR` for inspection. |

Run one file or test with `npx playwright test e2e/navigation.spec.ts` or `-g "<name>"`.
Failure traces and backend/Vite logs are attached to the report under
`node_modules/.cache/haxy-e2e/test-results`. Playwright uses Chromium 1243
(`@playwright/test` is pinned to 1.63.0); install it with `npx playwright install chromium`
if it isn't cached.

Haxy's own suites run from `../haxy`: `zig build test` (and `zig build testnet`).

## Development

```sh
npm run typecheck   # includes e2e/ and the Playwright config
npm run build
npm run preview
npx shadcn@latest add dialog
```

`@/` resolves to `src/`. shadcn configuration lives in `components.json`, component
source in `src/components/ui`, and the Tailwind theme in `src/index.css`.

Build output is in `dist/`. `preview` serves that output on port 4173 with the same
backend proxy, for local verification. Vite dev/preview are not production servers.
Production will need a static host plus an `/api/` reverse proxy to Zig (or a small
Node service if server-side UI behavior is introduced later).
