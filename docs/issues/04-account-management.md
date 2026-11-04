# #04 Account management: registration, email, password, SSH keys, and account deletion

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 10, 15, 19, 20, 21, 22, 23, 24

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Complete the server-mode account lifecycle in the browser, reusing the existing NewUser, UserSettings, UserKeys and Delete operations:

- Register with username, email, password and confirmation under existing validation rules.
- Update email; change password with current-password and confirmation checks.
- List SSH keys with fingerprints; add supported public keys (duplicate, invalid and limit errors surfaced); remove with confirmation.
- Delete the account with the existing password + typed-confirmation safeguards and a clear statement of what is deleted.

Forms show field-level errors and preserve non-secret input on failure.

## Acceptance criteria

- [ ] Registration, email change, password change, key add/remove and account deletion work end-to-end and persist across refresh and backend restart
- [ ] Validation failures appear beside the field; non-secret inputs are preserved, password fields are not
- [ ] Duplicate / invalid / over-limit SSH key errors are shown
- [ ] A deleted account cannot log in and its owned resources follow existing deletion behaviour
- [ ] Another user cannot change these settings via direct API calls
- [ ] Local mode shows account features as unavailable
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#03 Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md)
