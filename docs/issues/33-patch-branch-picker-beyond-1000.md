# #33 Patch branch pickers beyond 1,000 branches

**Type:** AFK · **Status:** done · **User stories:** 64, 72

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#18](18-patches-branch-write.md) review (merged with this open, by user decision)

## What to build

The New patch and patch edit forms choose source and target branches from pickers that list at most 1,000 branches, with no way to name a branch that isn't listed. In a repository with more branches, the rest can't be chosen from Hub, though Haxy itself accepts them. Let a contributor find any branch: a searchable picker over Haxy's branch list, a typed name checked against the repository, or both. Names that aren't valid UTF-8 must still travel as byte-exact ref ids.

## Acceptance criteria

- [x] In a repository with more than 1,000 branches, any branch can be chosen as source or target, and the patch persists and shows in the TUI
- [x] A typed or searched name that names no branch is refused with a field error before or by Haxy
- [x] Branches whose names aren't valid UTF-8 remain selectable without ambiguity
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded (`9af6d92` on `haxy-hub-impl`)

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)

## Implementation notes

**Backend (`haxy`).** The repository overview (`src/api/repo.zig`) gains `default_branch_id`, the
branch HEAD names as a byte-exact ref id beside its display name (null for a detached HEAD). No
new route: the pickers search the existing branch list (`…/branches?search=&cursor=`, #06), which
already pages by name prefix from the TUI's refs window.

**Haxy Hub.**

- `src/lib/patches.ts`: `getBranchChoices` no longer reads up to 1,000 branches. It returns a
  `search` over the branch list (`BranchSearch`, 50 per page, `branchPageSize`) and the default
  target by the overview's `default_branch_id` (none when the default branch has no commits), so
  the target needs no display-name matching (`defaultTargetOf` now reads the id).
- `src/lib/branchPicker.ts`: the picker's pure rules (what it sends, what it searches, how a
  name shows).
- `src/components/thread/BranchFields.tsx`: each branch field is a combobox: a text field whose
  list shows the branches starting with what is typed, with "More branches" for the next page,
  arrow keys, Enter and Escape. Picking sends the listed id; a typed name is sent as typed
  (`branchId`), and Haxy refuses one that names no branch with its field error. Names that aren't
  UTF-8 show their encoded bytes in the list and under the field once picked. `ThreadNew`,
  `ThreadEdit` and `ThreadForm` are unchanged (`BranchOffer` keeps its shape).

**Decisions.**

- Search, not a longer list: any branch is reached by typing the start of its name (Haxy's
  prefix search); the exact name always sorts first among its matches.
- A typed name that isn't picked is sent as typed and checked by Haxy (its existing
  `validation` on `source`/`target`); before sending, the list says when no branch starts with
  the text. Hub doesn't refuse it itself, so the check is Haxy's one rule.
- Names that aren't UTF-8 can be picked but not typed; the list and the chosen field show their
  percent-encoded bytes to tell look-alikes apart.
- The new form's default target is now picked even when its name isn't UTF-8 (by its exact id),
  where #18 picked none.

**Review round 1 (Codex).**

- Tabbing from the field to the list's "More branches" or "Try again" closed the list (the
  field's blur closed it unconditionally), so paging and retrying were mouse-only: the list now
  closes only when the focus leaves the whole picker, the listbox is out of the tab order (Chrome
  makes scroll containers focusable), and both buttons hand the focus back to the field, its
  active option the first branch they add.
- Arrow keys moved the active option out of the 256px list's sight: it is scrolled into view
  (`block: "nearest"`) whenever it changes.
- Test: `patches-branches.spec.ts` "the branch list is used from the keyboard" (both failed
  before the fixes).

**Review round 2 (Codex).**

- Reopening a loaded picker shows what it had and refreshes its first page 200 ms later; "More
  branches" pressed meanwhile was undone by that refresh. Reading more now cancels the pending
  refresh (test: "reading the next page of a reopened list isn't undone…", with Playwright's
  clock).
- ArrowDown, Enter and Escape sent while an input method composes text moved, picked or closed
  in the list. The picker now leaves keys with `isComposing` (or key code 229, Safari's last
  composition key) to the input method (`composesText` in `src/lib/branchPicker.ts`; test: "keys
  that compose text in an input method are left to it", which dispatches composing keys, since
  Playwright can't drive an input method).

**Review round 3 (Codex).** The picker's state was reworked so that a list's change can't carry
stale keyboard state or drop the focus:

- The active option is kept by branch id, not by index, and is cleared on a pick: a picked
  branch's list reopening on the full list no longer highlights whatever sits at the old index,
  where Enter replaced the chosen branch (test: "a picked branch stays chosen when its list
  reopens on other branches").
- A read no longer replaces the list with a loading line: the branches and their buttons stay
  shown until the answer replaces them, the list marked `aria-busy` and the buttons
  `aria-disabled`, beside a "Searching the branches…" status. So a reopened list's refresh landing
  while "More branches" or "Try again" has the focus leaves it there; if the answer takes that
  button away (no next page any more), the focus goes back to the field (`useFocusWithin`). Test:
  "a reopened list's refresh keeps the focus in the picker, on its button while it stays", with
  Playwright's clock, and branches deleted out of band for the second case.

**Review round 4 (Codex).** Keeping a list shown while a new search runs let its rows be chosen
for a prefix no longer typed (`alpha` listed, `zebra` typed, ArrowDown and Enter picked `alpha`).
Rows answering another search than the one typed now stay shown but inert: `aria-disabled`, no
arrow or Enter reaches them, and a click does nothing (test: "the branches of a search no longer
typed are shown but can't be chosen", with Playwright's clock holding the search back).

**Found, not fixed.** Haxy's own web pages (the TUI's) answer 500 (`InvalidUtf8`) for every page
of a local repository holding a branch whose name isn't UTF-8 (`/`, `/refs`, `/patches/open`
alike, whatever HEAD names), so a patch between such branches is checked through Haxy's API, not
its patch page. This predates #33 and isn't patch-specific.

**Tests.** `e2e/patches-branches.spec.ts`: 1,100 branches, a source past the first 1,000 found by
search and picked, a target past them typed in full, a retarget through "More branches", each
checked after a refresh, in the API and in the TUI's patch page and edit form (which holds the
target); a typed name that names no
branch refused beside its field (source and target) with nothing opened; two branches that show
as `caf�`, the default one the exact target, the other picked by its encoded name, kept through
an edit. `e2e/patches-write.spec.ts` uses the pickers (`chooseBranch`, `branchPicker` in
`e2e/support/patches.ts`); `e2e/refs-api.spec.ts` and `e2e/repo-api.spec.ts` cover
`default_branch_id`.
