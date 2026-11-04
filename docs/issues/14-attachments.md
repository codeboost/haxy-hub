# #14 Attachments: upload, download, and remove

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 57, 58, 59

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Contributors attach files to supported threads and comments, readers open or download them with correct filenames and content handling, and authorized users remove them with confirmation. Use bounded/streamed transfers (not page snapshots), expose backend size/type constraints, and authorize both reads and writes. Upload requests are exempt from the short status timeout.

## Acceptance criteria

- [ ] Upload, download and remove work and persist
- [ ] Over-limit and invalid uploads show useful errors
- [ ] Attachments on private repos are not readable by unauthorized users (direct URL check)
- [ ] Downloaded filename and content type are correct; active content is not rendered inline unsafely
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#13 Comments: pagination, replies, permalinks, edit and remove](13-comments.md)
