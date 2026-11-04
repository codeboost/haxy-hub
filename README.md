# Haxy Hub

React + TypeScript, Vite, Tailwind CSS v4, and shadcn/ui with Radix primitives.
Vite serves the UI and proxies `/api/*` to Zig. There is no separate Express
server, no browser CORS setup, and no forge logic in Node.

This frontend lives in `haxy-hub/`, alongside the backend's `haxy/` repository.

## Start locally

First build and start the updated Zig backend using the repository's Zig 0.17.0
toolchain. From the sibling `haxy/` repository root, `zig build try` starts the demo server on
port 8080 (and its terminal interface). You can also use your existing `haxy serve`
setup, or Haxy's local mode with its web listener.

In a second terminal, from the `haxy/` repository root:

```sh
cd ../haxy-hub
npm ci
npm run dev
```

Open http://127.0.0.1:5173. The initial screen checks the backend and offers a retry
if it is unavailable. This is the UI foundation; repository, issue, and patch
screens are not implemented yet.

The backend defaults to http://127.0.0.1:8080. To change it, copy `.env.example` to
`.env.local`, edit `HAXY_BACKEND_URL`, and restart Vite. Alternatively:

```sh
HAXY_BACKEND_URL=http://127.0.0.1:9090 npm run dev
```

The backend setting stays in the Node process; browser requests always use relative
`/api/` URLs. Paths and query strings are forwarded unchanged, along with cookies.
Vite preserves Host and Origin. Future authenticated write endpoints must implement
authorization and CSRF checks in Zig; proxying alone does not provide those checks.

## Current API

`GET /api/v1/status` (also supports HEAD) returns:

```json
{ "service": "haxy", "api_version": 1, "mode": "server" }
```

Mode is `local` or `server`. This checks HTTP connectivity, not repository health.
Unknown API paths return JSON 404; unsupported status methods return JSON 405.
An older Zig binary without this route is reported as incompatible, not connected.
Frontend requests have a ten-second timeout.

## Development

```sh
npm run typecheck
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
