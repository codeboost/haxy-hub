# #28 Parity audit: accessibility, responsive layout, cross-client, and story mapping

**Type:** HITL · **Status:** needs-human · **User stories:** 5, 7, 8, 101 + completion criteria

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Verify the spec's completion criteria across the finished slices: every numbered user story maps to an implemented workflow and acceptance check (or is marked mode-inapplicable with evidence); keyboard-only use with visible focus and focus restoration; narrow-screen usability; deep links, back/forward and refresh; and cross-client behaviour (React changes visible in the TUI, TUI changes visible after React refresh). Fill any gaps found as new issues.

**HITL:** human review of the story-to-test mapping and a manual accessibility pass.

## Acceptance criteria

- [ ] Story-to-acceptance-check mapping document covers all 101 stories
- [ ] Keyboard-only and narrow-viewport Playwright runs pass for representative workflows
- [ ] Cross-client test: write via React, read via existing Zig views; write via Zig, read via React after refresh
- [ ] Two-process startup works from a clean checkout; full acceptance suite passes against a recorded backend revision


## Blocked by

- All of #01–#27
