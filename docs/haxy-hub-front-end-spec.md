# Haxy Hub front end parity with the TUI

## Problem Statement

Haxy Hub currently provides a React connection screen, but users must return to Haxy's terminal interface or its existing browser renderer to do forge work. They cannot yet browse repositories, collaborate on issues and patches, manage access, or use Haxy's local-first workflows through the new interface.

The goal is functional parity with the existing TUI: the same supported tasks, data, permissions, and outcomes through a browser-native interface. Parity must cover both a multi-user Haxy server and a local repository served by Haxy. These modes have different capabilities and must not be presented as interchangeable.

## Solution

Build Haxy Hub as an independent React and TypeScript application using Vite, Tailwind CSS, and shadcn/ui components backed by Radix UI. Users start the Zig backend and the UI server separately. Vite serves the interface and proxies HTTP API requests to the configured local Zig server.

Provide browser-native navigation, forms, lists, file views, diffs, and accessible dialogs. Retain Zig as the authority for authentication, authorization, repository access, event processing, patches, and synchronization. Users can move between the React UI and the TUI without changing the underlying storage or collaboration model.

Use Haxy's domain language: repositories, issues, discussions, patches, patch revisions, forks, events, grants, roles, notifications, and undo history. A patch is Haxy's change proposal; a fork can be the working repository backing a draft or published patch. Do not substitute a different pull-request or fork lifecycle.

### Parity boundaries

| Area | Multi-user server | Local repository |
| --- | --- | --- |
| Files, refs, commits, and diffs | Browse repositories the viewer may read | Browse the repository opened by Zig |
| Users and accounts | User directory, registration, login, settings, keys, deletion | No server accounts or login |
| Issues, discussions, comments, attachments, assignments | Existing role and feature settings apply | Existing local event-editing behavior applies |
| Patches | Branch-backed patches, fork-backed drafts, publishing, merging, and fork browsing | Existing branch-backed patch and metadata workflows; no server draft/fork account workflow |
| Notifications | Existing inbox, subscriptions, mute, and unread behavior | Unavailable |
| Repository administration | Existing settings, member management, branch protection, and deletion permissions | Server administration unavailable |
| Events | Active/removed event browsing and supported transaction filtering | Event browsing plus synchronization with the configured remote |
| Undo | History visible to eligible roles; execution restricted to the main owner | Unavailable |

This matrix describes the current capability split, not a grant of additional permissions. Backend capabilities and current authorization determine each action's availability, including exceptions involving removed targets or stale state.

## User Stories

### Connection and navigation

1. As a developer, I want to start Haxy and Haxy Hub independently, so that I can work on the frontend without changing how the forge runs.
2. As a user, I want to see whether my backend is reachable and compatible, so that connection problems are distinguishable from empty repositories.
3. As a developer, I want to configure the backend address without editing frontend code, so that I can use different local ports.
4. As a user, I want the interface to identify server or local mode, so that I understand which workflows are available.
5. As a user, I want direct links to repositories, files, commits, threads, comments, and patch revisions, so that I can bookmark and share the view I am using.
6. As a user, I want browser back, forward, and refresh to preserve the selected resource, filters, and pagination, so that navigation is predictable.
7. As a keyboard user, I want to reach and operate every control with visible focus, so that I can complete the same tasks without a mouse.
8. As a user on a narrow screen, I want readable lists, details, forms, and horizontally scrollable code, so that the interface remains usable without a desktop layout.
9. As a user, I want clear loading, empty, unavailable, forbidden, not-found, and failed-operation states, so that I know what happened and what I can do next.
10. As a user completing a form, I want validation errors beside the relevant fields and non-secret input preserved after failure, so that I can correct a submission without retyping it.

### Discovery and accounts

11. As a visitor, I want to read the forge's existing about information, so that I understand Haxy and how to use this instance.
12. As a visitor, I want to search and paginate the user directory, so that I can find a repository owner.
13. As a visitor, I want to browse and search an owner's visible repositories, so that I can find projects relevant to me.
14. As an authorized viewer, I want to browse a user's visible forks and follow their associated patches, so that I can understand ongoing contributions.
15. As a visitor, I want to register with the existing username, email, password, and confirmation rules, so that I can participate in the forge.
16. As a registered user, I want to log in from my current context and return to it, so that authentication does not interrupt my work.
17. As a registered user, I want my existing session to persist across navigation and refresh, so that I do not repeatedly log in.
18. As a registered user, I want to log out and have private cached content cleared, so that the interface no longer exposes my account's data.
19. As a registered user, I want to update my email using Haxy's existing validation rules, so that my identity remains current.
20. As a registered user, I want to change my password with the existing current-password and confirmation checks, so that I can manage account access.
21. As a registered user, I want to view my SSH keys and fingerprints, so that I can recognize authorized keys.
22. As a registered user, I want to add supported SSH public keys and receive useful duplicate, invalid-key, and limit errors, so that I can connect with my terminal.
23. As a registered user, I want to confirm removal of an SSH key, so that I can revoke access deliberately.
24. As an account owner, I want to delete my account using Haxy's existing password and typed-confirmation safeguards, so that I understand the effect on everything I own.

### Repository creation and source browsing

25. As a registered user, I want to create a repository with a name, description, visibility, and supported hash format, so that I can host a project with the intended configuration.
26. As a registered user, I want to create a repository by copying an accessible existing repository using Haxy's supported copy option, so that I can start from an existing project without inventing a different fork workflow.
27. As a repository reader, I want to see the repository identity, description, and available sections, so that I can orient myself.
28. As a repository reader, I want to copy the clone and contribution commands supported by the backend, so that I can work with the repository locally.
29. As a repository reader, I want to browse directories and navigate parent paths, so that I can find source files.
30. As a repository reader, I want to view files at a branch, tag, commit, or supported patch revision, so that I can inspect the intended version.
31. As a repository reader, I want to read numbered file content and follow links to a selected line or content window, so that I can reference specific code.
32. As a repository reader, I want README and supported Markdown content rendered safely, so that documentation is readable.
33. As a repository reader, I want clear empty-file, binary-file, truncated-content, and empty-repository states, so that missing text is not mistaken for a loading failure.
34. As a repository reader, I want indexed file finding where Haxy supports it, so that I can locate files without traversing every directory.
35. As a repository reader, I want to search and paginate branches and tags, so that I can choose a ref in a large repository.
36. As a repository reader, I want to browse paginated commit history with author, committer where different, timestamp, message, merge indication, and available statistics, so that I can understand changes.
37. As a repository reader, I want to open a commit's full message within the existing size limits, so that I can read the explanation behind a change.
38. As a repository reader, I want indexed commit search where available, so that I can find relevant history.
39. As a repository reader, I want to follow a commit into its files and diff, so that I can inspect both the resulting tree and the change.
40. As a repository reader, I want paginated diffs showing added, removed, and changed content with supported path filtering, so that I can review changes without loading an entire large diff at once.
41. As a patch reviewer, I want base-bounded commit lists and diffs to use the backend's revision semantics, so that I review the actual proposal rather than unrelated history.

### Issues and discussions

42. As a repository reader, I want separate open and closed issue views with counts and pagination, so that I can distinguish active work from completed work.
43. As a repository reader, I want to search issues using Haxy's supported text, label, and assignee filters, so that I can narrow the backlog.
44. As a repository reader, I want a label listing that links into filtered threads, so that I can discover categories used by the project.
45. As an authorized contributor, I want to create an issue with a title, description, and labels, so that I can report or propose work.
46. As an authorized contributor, I want to edit an issue's supported fields, so that its details can evolve.
47. As an authorized contributor, I want to close and reopen issues, so that their status reflects current work.
48. As an authorized contributor, I want to confirm removal of an issue, so that accidental destructive actions are less likely.
49. As a repository reader, I want to browse, search, and paginate recent discussions, so that I can find project conversations.
50. As an authorized contributor, I want to create and edit discussions with descriptions and labels, so that I can start and maintain conversations outside issue tracking.
51. As an authorized contributor, I want to confirm removal of a discussion, so that I can manage content within my existing permissions.
52. As a thread reader, I want to open a full description independently of the list view, so that lengthy content remains readable and linkable.

### Comments, attachments, and assignment

53. As a thread reader, I want to read paginated comments with author and reply context, so that I can follow an issue, patch, or discussion.
54. As a contributor, I want to comment on a thread or reply to a particular comment, so that my response has the right context.
55. As a thread reader, I want comment permalinks that show the selected comment and its supported reply context, so that I can share a specific exchange.
56. As an authorized contributor, I want to edit and confirm removal of comments, so that I can correct or moderate content within Haxy's rules.
57. As an authorized contributor, I want to attach files to supported threads and comments, so that I can share relevant material.
58. As an authorized reader, I want to open or download attachments with their filenames and appropriate handling, so that I can use the shared material.
59. As an authorized contributor, I want to remove attachments with confirmation and see upload validation failures, so that I can manage attachments reliably.
60. As a thread reader, I want to see assignees by account name when resolved and otherwise by email, so that responsibility is understandable in both modes.
61. As an authorized contributor, I want to assign and unassign people using Haxy's existing identity-resolution rules, so that I can coordinate responsibility.
62. As a repository reader, I want assignee links to show the corresponding filtered issues, so that I can find someone's work.

### Patches and forks

63. As a repository reader, I want separate open, closed, and merged patch views with search, labels, counts, and pagination, so that I can find and assess proposals.
64. As an authorized contributor, I want to create a patch from an existing source branch and target branch, so that I can propose changes already present in the repository.
65. As an authorized server contributor, I want to start a patch using a new fork, so that I can develop a contribution without direct access to the target branch.
66. As a contributor, I want to list, open, edit, and remove my available patch drafts, so that I can prepare proposals before publishing them.
67. As a contributor, I want to publish a draft using Haxy's existing preconditions, so that a prepared contribution becomes a repository patch.
68. As a fork owner or authorized reader, I want to browse a fork's files, commits, diff, and associated patch, so that I can inspect its current state.
69. As a contributor, I want to copy the available fork push, clone, and fetch/merge commands, so that I can use Git to update or try the contribution.
70. As a patch reader, I want to see source, target, current revision, commit count, no-change state, and available mergeability information, so that I understand what the proposal contains.
71. As a patch reviewer, I want links to the supported patch revision's files, commits, and diff, so that review stays attached to the correct code.
72. As an authorized contributor, I want to edit patch metadata and close or reopen a patch, so that its description and status remain accurate.
73. As an authorized contributor, I want to remove a patch using its existing removal semantics, so that I can manage obsolete proposals.
74. As an authorized maintainer, I want to merge an eligible patch using its source revision, so that I can integrate the contribution with Haxy's existing behavior.
75. As an authorized maintainer, I want to squash-merge an eligible patch, so that I can use the alternative integration method already supported by Haxy.
76. As a maintainer, I want merge failures and changed eligibility reported without a false success state, so that I can reassess stale, conflicting, or unavailable proposals.
77. As a fork reader, I want the UI to explain when a fork's target has been deleted, so that I understand which remaining operations are still possible.
78. As a fork owner, I want to delete a fork with the existing password and typed-confirmation checks, so that I can deliberately remove it.

### Conflicts, events, and local work

79. As a collaborator, I want to find issues and patches with unresolved metadata conflicts, so that I can identify changes requiring reconciliation.
80. As an authorized collaborator, I want to inspect both sides and their authors for conflicting fields and description chunks, so that I can choose an informed resolution.
81. As an authorized collaborator, I want to submit supported per-field and description resolutions, so that the event history records the resolved state.
82. As a repository user, I want to browse active and removed events with their kind, author, and available detail links, so that I can inspect metadata history.
83. As an eligible repository user, I want to view events associated with a supported transaction, so that I can understand an operation's effects.
84. As a local user, I want to browse and edit supported repository metadata while disconnected from a remote, so that the local-first workflow remains useful.
85. As a local user, I want to synchronize events with the configured remote through Zig, so that local and remote metadata can converge using existing merge rules.
86. As a local user, I want sync failures reported accurately while retaining any locally applied changes, so that I can resolve transport or conflict problems without assuming everything rolled back.
87. As an eligible server user, I want to browse paginated undo history with action descriptions, timestamps, and related details, so that I can inspect restorable changes.
88. As a repository main owner, I want to confirm and execute an available undo, so that I can restore a prior state under the backend's current authorization and history rules.
89. As a repository main owner, I want to see the resulting undo record and any supported restoration action, so that I can understand and, where allowed, reverse the undo itself.

### Notifications and administration

90. As a registered user, I want a paginated notification inbox with unread indicators and links to threads, so that I can follow activity relevant to me.
91. As a registered user, I want the unread count and read state to update when I actually view the relevant thread, so that the inbox reflects what I have seen.
92. As a registered user, I want to subscribe to or mute supported threads and see any subscription-capacity error, so that I can control notifications within existing limits.
93. As a repository owner, I want to change the repository description, public/private visibility, and supported thread-creation role settings, so that access reflects the project's needs.
94. As a repository owner, I want to view the repository's hash format, so that I understand its existing configuration without implying it can be changed.
95. As a repository owner, I want to inspect and paginate the existing member listing and grant, revoke, promote, or demote members as supported, so that I can manage collaboration.
96. As an authorized repository owner, I want to choose the default branch, so that visitors land on the intended code.
97. As an authorized repository owner, I want to protect and unprotect branches, so that existing force-push and deletion protections can be managed from the web UI.
98. As a repository main owner, I want to delete the repository with the existing password and typed-confirmation checks, so that I understand the permanent consequences.
99. As a user whose permissions change, I want the next request to reflect current permissions, so that stale browser state never grants access or claims an operation succeeded.
100. As a visitor, I want private or inaccessible resources to follow Haxy's existing visibility rules, so that the new interface does not disclose information hidden by the TUI.
101. As a user switching between clients, I want successful React changes to appear in the TUI and TUI changes to appear after a React refresh, so that both interfaces remain views of the same forge.

## Implementation Decisions

### Architecture and ownership

- Keep Haxy Hub in its independent repository, with the agreed React, TypeScript, Vite, Tailwind, shadcn/ui, and Radix stack. Keep Node limited to development/build tooling and HTTP proxying for this scope.
- The browser communicates through its UI origin. The configured Zig origin remains a server-side Vite setting. Retain the existing API namespace and versioning approach; do not proxy arbitrary browser-selected destinations.
- Zig owns all forge rules, sessions, authorization, filesystem operations, event writes, patch execution, and sync. React owns presentation and transient interaction state. Do not create a second database or implement Git/event logic in Node.
- Extend the existing status API into a coherent JSON API. The status screen alone is complete today; all feature APIs and screens in this spec are new work.
- Reuse existing repository queries, event operations, and permission checks. Extract shared queries and commands from presentation/form handlers as features require them. Both the TUI and JSON handlers must call the same underlying operations; do not duplicate their rules.
- Keep existing terminal, SSH, browser-rendered TUI, and Git transport behavior working. Changes to shared modules require the relevant existing tests.
- Treat functional outcomes as the parity target. React is not required to reproduce terminal grid geometry, focus IDs, or every terminal-specific keystroke.

### API contract

The following are required API capabilities, not a commitment to a particular endpoint per table row. Establish explicit request and response schemas and matching TypeScript types before implementing each slice.

| API area | Required capabilities |
| --- | --- |
| Connection and session | Compatibility, host mode, active viewer, capabilities, registration, login, logout |
| Discovery | About data, users, visible repositories, visible forks, existing search and pagination |
| Source | Ref selection, directory/file windows, indexed file finding, commit windows and search, full messages, diffs, patch-revision context, backend-provided Git commands |
| Threads | Issues, discussions, and patches with their distinct statuses; details, supported filters, labels, create/edit/remove and supported status transitions |
| Collaboration | Comment windows and permalinks, replies, attachments, assignment and removal |
| Patch workflow | Branch-backed creation, fork-backed drafts, publishing, fork navigation, mergeability, source/squash merging, draft/fork deletion |
| Conflicts and history | Issue/patch conflict detail and resolution, active/removed events, transaction views, undo history and execution |
| Accounts and administration | User settings, keys, notification state, subscribe/mute, repository creation/copy/settings, member actions, branch settings, guarded deletion |
| Local mode | Local capability context, existing local metadata operations, event synchronization and result reporting |

- Use stable event IDs, repository identities, and Git object IDs. Keep IDs opaque to React and accommodate the repository's supported hash formats. Encode refs, filenames, and query values correctly, including slashes, spaces, Unicode, and punctuation.
- Represent large numeric identifiers or ordering tokens without JavaScript precision loss. Define timestamp units, optional-field semantics, and discriminated variants explicitly.
- Return domain-oriented data rather than terminal widgets or arbitrary serialized internal structs. Do not expose passwords, password hashes, session tokens in JSON, local filesystem paths, signing configuration, or SSH private material.
- Include viewer capabilities and action availability where useful, with reasons for unavailable actions. Always recheck authorization and operational preconditions on the backend at execution time.
- Preserve existing pagination and bounded reads. Responses must distinguish exact counts from lower bounds, truncated results, more pages, binary files, no commits, missing indexes, and unavailable optional statistics.
- Preserve current search semantics, including supported label and assignee filters. Do not invent global search or promise indexing on unsupported refs.
- Return structured errors with stable codes, a user-facing message, and field errors where appropriate. Distinguish validation, unauthenticated, forbidden, hidden/not-found, conflict/stale state, unsupported operation, and backend failure without disclosing private resource existence.
- Return authoritative resulting state or a stable resource identity after mutations. Refresh affected lists, details, counts, permissions, and notifications. Never render a mutation as successful before backend confirmation.
- Prevent duplicate submission while a request is pending. Do not automatically retry writes with an ambiguous result; reload authoritative state before offering a deliberate retry. Recheck patch revision and target state before merging, and surface any concurrent change according to the backend's semantics.
- Keep long-running merge and sync operations distinguishable from connectivity failure. The starter's ten-second status timeout must not become a blanket timeout for uploads or repository operations. If operations require asynchronous completion, implement it in Zig with explicit completion/failure results; Node must not take ownership of the work.

### Authentication and permissions

- Reuse Zig's cookie-backed session model. The proxy forwards cookies and cookie updates; browser code must not store session tokens in local storage. Clear viewer-specific client state on logout, session invalidation, and relevant authorization changes.
- Require same-origin protections for state-changing API calls, including local-mode writes. Use an explicit CSRF strategy compatible with the proxy; do not treat the absence of CORS configuration as write protection.
- Preserve Haxy's role vocabulary: read, write, owner, plus the distinction between the repository's main owner and other granted owners. Resource authorship and per-thread settings also affect actions.
- Match existing main-owner restrictions for account, repository, and fork deletion and for undo execution. Retain typed identity and password confirmation where existing deletion flows require them.
- Preserve feature-disable behavior and per-kind creation thresholds. Direct API access must enforce the same restrictions as visible controls.
- Keep local mode account-free and use the backend's existing local author/configuration rules. Do not synthesize a server account or send local credentials to React.
- Use the server's public transport configuration when displaying clone/push commands. The frontend port is not automatically a Git transport endpoint. Preserve current HTTP clone/fetch and SSH push availability rather than implying new HTTP push support.

### Interface behavior

- Build shared application navigation, repository context, paginated lists, search controls, forms, thread detail, comment/reply views, Markdown content, confirmation dialogs, and failure states. Compose issues, discussions, and patches from shared components while preserving their different workflows.
- Use routes to represent resource identity, selected ref/revision, search/filter state, page/window, and supported detail views. Direct navigation and refresh must reconstruct the same context. Preserve equivalent destinations for existing Haxy links; document any route mapping rather than silently losing ref or revision context.
- On narrow screens, list and detail may become separate views; browser back returns to the prior list context. Keep diffs and long source lines scrollable without causing the entire application layout to overflow.
- Use semantic controls, accessible names, visible focus, keyboard-operable menus/dialogs, focus restoration, and announced loading/error states. Status differences must not depend on color alone. Preserve standard browser text selection, copy, and input editing.
- Render supported Markdown safely and handle links and attachment content deliberately. Match meaningful content and links rather than terminal formatting. Unsafe HTML and URL schemes must not execute.
- Show clear confirmation and consequences for remove, delete, merge, access changes where currently confirmed, and undo. Preserve backend distinctions between event removal and permanent deletion.
- Reproduce notification read behavior when a user views the relevant content. Avoid marking notifications read merely because navigation prefetches a resource; use an explicit acknowledgement operation if needed.
- Represent metadata conflicts separately from code mergeability. Do not present the metadata resolution form as a source-code conflict editor.
- Preserve existing draft privacy and lifecycle. Local mode offers branch-backed patches, while account-owned fork drafts and server merge actions remain unavailable there.
- Expose backend-supported attachment constraints and errors. Use bounded or streamed transfer handling rather than routing attachment bytes through page snapshots. Authorize both attachment reads and writes.
- Revalidate on relevant navigation, explicit refresh, and successful mutations so work from another client becomes visible. Live push updates are not required for parity.

### Storage and delivery sequence

- No change to the existing event format, event branch, database model, or merge policy is required by this spec. A later discovered schema requirement must be justified separately; React must not create a parallel source of truth.
- Implement vertical slices that include the Zig API, React workflow, and acceptance coverage: connection/session/discovery; repository source browsing; issues and shared collaboration; discussions; patches/forks; administration/notifications; conflicts/events/local sync/undo.
- Use this order for delivery, not as a reduction of scope. A slice is complete only when its applicable roles, modes, failure states, and persistence behavior work.
- Add an executable test/startup workflow that selects a backend binary and creates isolated test data, so the two independent repositories can be verified together without relying on a developer's running forge.

## Testing Decisions

### Agreed primary boundary

The user confirmed browser workflows through Vite's proxy to a real Zig backend, using isolated fixture repositories, as the primary testing boundary. Retain existing Zig domain tests. This boundary exercises React, routing, forms, API contracts, cookies, authorization, and persistence together.

- Use browser-driven acceptance tests, proposed with Playwright, against actual Zig processes and temporary repositories. Do not replace the API with mocks for parity acceptance. Browser navigation, visible outcomes, and resulting persisted behavior are the assertions.
- Seed fixtures through existing Zig setup/event utilities and supported Git operations. Reuse their domain setup rather than hand-editing databases. Tests must never use the developer's live data directory or real credentials.
- Run server-mode fixtures with anonymous, reader, writer, granted-owner where supported, main-owner, and unrelated-user contexts. Include author versus non-author cases, public/private repositories, disabled thread kinds, and changed permissions after a page has loaded.
- Run local-mode fixtures for the supported Git and xit backends and hash formats where relevant. Assert both available local operations and the absence/rejection of server-only actions.
- Prefer assertions such as “the newly created issue is visible after refresh and a backend restart” and “a revoked writer cannot submit an edit” over component-tree snapshots, CSS classes, internal function calls, or exact HTTP request counts.
- Supplement browser tests with focused HTTP contract/security cases only when the browser cannot express the failure effectively, such as forged permissions, malformed inputs, or unsafe paths. Drive the same running server and fixture harness rather than introducing another mocked service boundary.
- Keep fine-grained algorithmic edge cases in existing Zig tests for event merging, patch lifecycle, notifications, history, and transport. Add tests there only when a shared behavior changes; do not duplicate every domain case in the browser.

### Prior art to retain and extend

- Existing UI tests cover form focus/input, hidden versus off-screen controls, diff windows across multiple commits, encoded refs in route round-trips, base-bounded commit traversal, and local sync preserving HEAD.
- Existing event tests cover user/repository records, newest-first pagination, fork removal lifecycle, notifications, branch-backed patch merging, patch lifecycle, stacking, conflict handling, and garbage collection.
- Existing undo tests cover history pagination, restorable undo records, visibility versus execution authorization, fresh authorization after ownership changes, malformed history, and local mode's lack of undo.
- Existing network tests cover real clone/fetch/push behavior, pushing events and forks, and push effects on undo history. These remain the regression basis for shared backend changes.
- The frontend already passes TypeScript checking and a production build; ad hoc proxy verification established path/query and cookie forwarding. This is setup verification, not existing end-to-end parity coverage.

### Acceptance coverage

| Workflow | Required observable evidence |
| --- | --- |
| Startup and connection | Both processes start independently; alternate backend ports work; unavailable and incompatible backends show recoverable errors |
| Accounts | Registration/login/logout/settings/key flows work; invalid values preserve non-secret input; deleted or invalidated identities lose access |
| Source navigation | Empty and populated repos, branch/tag/object selection, encoded paths/refs, large file windows, binary placeholders, Markdown, search availability, bounded history, and diffs behave correctly |
| Threads | Create/edit/remove and supported status transitions persist; filters, labels, pagination, comments, replies, and permalinks retain context |
| Attachments and assignment | Upload/read/remove and assign/unassign succeed only with appropriate authority; invalid and over-limit inputs produce useful failures |
| Patches | Branch and fork workflows, draft privacy, publish, current revision review, source/squash merge, no-change state, stale targets, removed targets, and unavailable actions match Zig behavior |
| Conflicts | Divergent metadata edits expose both sides; resolution persists through normal event processing; code merge conflicts are not confused with metadata conflicts |
| Local sync | Offline local edits survive; sync reaches the configured remote, reports failures honestly, preserves the code HEAD, and exposes unresolved metadata conflicts |
| Notifications | Relevant activity updates the inbox; opening content updates read state; subscriptions/mute respect access and existing limits |
| Administration | Repository creation and supported copying work; visibility, member roles, feature settings, default branch, and branch protection apply to later reads/writes; confirmation and main-owner restrictions hold for deletion |
| Events and undo | Event views distinguish active/removed records and supported transaction context; eligible users can inspect history; only current authorized main owners can execute undo; local mode rejects it |
| Cross-client behavior | React mutations are readable through existing Zig views, and changes made through existing Haxy operations become visible after React refresh |
| Browser usability | Deep links, refresh, back/forward, keyboard-only use, narrow screens, safe Markdown, and form errors remain usable |

### Completion criteria

- Every numbered user story is mapped to an implemented workflow and an acceptance check, or explicitly marked inapplicable for a mode with evidence from existing backend behavior. Mode-inapplicable does not mean omitted globally.
- All applicable role/mode combinations in the parity matrix are exercised; representative denial cases prove backend enforcement independently of hidden UI controls.
- Mutations are verified after refresh and representative process restarts. Persistent outcomes, not transient success toasts, determine success.
- No required workflow falls back to an embedded terminal renderer or directs the user to the old browser UI to finish the task. Copyable Git commands remain valid where that is already Haxy's workflow.
- Frontend type checking and production build pass, the relevant existing Zig suites pass, and the browser acceptance suite passes against the documented compatible backend revision.
- The documented two-process startup works from a clean checkout with dependencies installed. No test depends on seeded demo auto-login or a developer's existing session.

## Out of Scope

- Replacing the Zig backend, event storage, Git implementation, or permission model.
- Building a custom Node application server, server-side React rendering, production hosting, deployment automation, or a new Git reverse proxy. Vite remains a local development/preview tool.
- Pixel-for-pixel recreation of the terminal UI, terminal transport controls, SSH key-based automatic browser login, and terminal-only quit behavior.
- JavaScript-disabled parity for the new React interface. The existing browser renderer retains its current behavior; the React application requires JavaScript.
- A browser-only offline database, service-worker synchronization, or a PWA. Offline use means React communicating with a running local Zig process without a remote connection.
- New forge features absent from the current TUI, such as CI pipelines, release management, organization/team accounts, OAuth, password-reset email, email notifications, approval reviews, inline code-review conversations, or source-code editing and conflict resolution in the browser.
- General branch/tag creation and deletion, new HTTP push support, general remote-URL import wizards beyond the existing repository-copy option, or new fork semantics beyond existing exposed workflows.
- Redesigning or expanding search indexes, lifting backend safety limits, and adding real-time WebSocket/SSE notifications.
- Adding new undo capabilities to local mode or broadening who can perform destructive operations.
- Publishing this spec to an issue tracker or creating implementation issues. The user requested a local documentation artifact instead.

## Further Notes

- Baseline: Haxy backend commit `8412518` plus the locally added status API; Haxy Hub initial commit `70ac9d5`. These identify the inspected implementation, not a promise of compatibility with every future upstream revision.
- Specification date: 4 November 2026. No domain glossary or ADR was found in either inspected project; terminology above follows the implemented routes, models, and tests.
- The user confirmed the real browser-to-backend testing boundary and requested that this spec be saved in Haxy Hub documentation instead of published. No issue-tracker setup or label change is required for this deliverable.
- The frontend and backend are independent repositories. Implementing this spec requires coordinated changes in both; record the compatible backend revision when each frontend slice lands.
- Repository history, events, and patch state have subtle semantics. Reuse existing operations and tests rather than inferring behavior from labels or recreating a generic Git hosting product.
- The complete inventory defines the parity target. It is not an instruction to implement all screens in one change, and completing an initial browsing or issue slice does not establish full parity.
