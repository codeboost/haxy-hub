# Haxy Hub issues

Generated from [the front-end spec](../haxy-hub-front-end-spec.md) as tracer-bullet vertical slices. Each slice spans the Zig JSON API (on the `haxy` repo's `haxy-hub-impl` branch), the React UI, and browser acceptance tests.

Status values: `ready-for-agent` (AFK) · `needs-human` (HITL) · `in-progress` · `done`.

| # | Issue | Type | Blocked by | Stories |
|---|---|---|---|---|
| 01 | [Foundation: acceptance harness, routed app shell, and API conventions](01-foundation-harness-and-app-shell.md) | HITL | – | 1, 2, 3, 4, 9 |
| 02 | [Discovery: about page, user directory, and an owner's repositories](02-discovery-about-users-repos.md) | AFK | [#01](01-foundation-harness-and-app-shell.md) | 11, 12, 13, 100 |
| 03 | [Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md) | HITL | [#01](01-foundation-harness-and-app-shell.md) | 16, 17, 18, 99 |
| 04 | [Account management: registration, email, password, SSH keys, and account deletion](04-account-management.md) | AFK | [#03](03-session-login-logout-csrf.md) | 10, 15, 19, 20, 21, 22, 23, 24 |
| 05 | [Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md) | AFK | [#02](02-discovery-about-users-repos.md) | 27, 28, 29, 31, 32, 33 |
| 06 | [Branch/tag selection and viewing files at any ref, commit, or revision](06-ref-selection.md) | AFK | [#05](05-repo-overview-and-file-browsing.md) | 6, 30, 35 |
| 07 | [Commit history, full commit messages, and commit search](07-commit-history-and-search.md) | AFK | [#06](06-ref-selection.md) | 36, 37, 38 |
| 08 | [Commit diffs with pagination and path filtering](08-commit-diffs.md) | AFK | [#07](07-commit-history-and-search.md) | 39, 40 |
| 09 | [Indexed file finder](09-file-finder.md) | AFK | [#06](06-ref-selection.md) | 34 |
| 10 | [Create a repository or copy an existing one](10-repo-create-and-copy.md) | AFK | [#03](03-session-login-logout-csrf.md), [#05](05-repo-overview-and-file-browsing.md) | 25, 26 |
| 11 | [Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md) | AFK | [#05](05-repo-overview-and-file-browsing.md) | 42, 43, 44, 52 |
| 12 | [Issues: create, edit, close/reopen, and remove](12-issues-write.md) | AFK | [#03](03-session-login-logout-csrf.md), [#11](11-issues-read.md) | 45, 46, 47, 48 |
| 13 | [Comments: pagination, replies, permalinks, edit and remove](13-comments.md) | AFK | [#12](12-issues-write.md) | 53, 54, 55, 56 |
| 14 | [Attachments: upload, download, and remove](14-attachments.md) | AFK | [#13](13-comments.md) | 57, 58, 59 |
| 15 | [Assigning and unassigning people](15-assignment.md) | AFK | [#12](12-issues-write.md) | 60, 61, 62 |
| 16 | [Discussions: list, search, create, edit, and remove](16-discussions.md) | AFK | [#13](13-comments.md) | 49, 50, 51 |
| 17 | [Patches: lists, detail, and revision review](17-patches-read.md) | AFK | [#08](08-commit-diffs.md), [#11](11-issues-read.md) | 41, 63, 70, 71 |
| 18 | [Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md) | AFK | [#12](12-issues-write.md), [#17](17-patches-read.md) | 64, 72, 73 |
| 19 | [Merge and squash-merge patches](19-patch-merge.md) | AFK | [#18](18-patches-branch-write.md) | 74, 75, 76 |
| 20 | [Fork-backed drafts: start a fork, manage drafts, and publish](20-fork-drafts-and-publish.md) | AFK | [#18](18-patches-branch-write.md) | 65, 66, 67, 69 |
| 21 | [Fork browsing, a user's forks, deleted targets, and fork deletion](21-fork-browsing-and-deletion.md) | AFK | [#20](20-fork-drafts-and-publish.md) | 14, 68, 77, 78 |
| 22 | [Notifications: inbox, read state, subscribe and mute](22-notifications.md) | AFK | [#13](13-comments.md) | 90, 91, 92 |
| 23 | [Repository administration: settings, members, branches, and deletion](23-repo-administration.md) | AFK | [#10](10-repo-create-and-copy.md) | 93, 94, 95, 96, 97, 98, 99 |
| 24 | [Event browsing and transaction views](24-events-browsing.md) | AFK | [#11](11-issues-read.md) | 82, 83 |
| 25 | [Metadata conflicts: find, inspect, and resolve](25-metadata-conflicts.md) | AFK | [#18](18-patches-branch-write.md) | 79, 80, 81 |
| 26 | [Undo history and execution](26-undo.md) | AFK | [#24](24-events-browsing.md) | 87, 88, 89 |
| 27 | [Local mode: offline metadata edits and remote sync](27-local-mode-sync.md) | AFK | [#12](12-issues-write.md), [#24](24-events-browsing.md) | 84, 85, 86 |
| 28 | [Parity audit: accessibility, responsive layout, cross-client, and story mapping](28-parity-audit.md) | HITL | all | 5, 7, 8, 101 + completion criteria |
| 29 | [Same-origin check for Haxy's HTML form routes](29-origin-check-for-html-form-routes.md) | AFK | [#03](03-session-login-logout-csrf.md) | 100 |
| 30 | [Writes never land under a different signed-in user](30-session-bound-write-identity.md) | AFK | [#04](04-account-management.md) | 99, 100 |
