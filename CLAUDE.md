## Coding rules

- Keep comments to a minimum, prefer no comments at all for most code. 

- Always use path.join() / path.resolve() from Node's path module for composing file paths. Never concatenate path segments with string operations (+, template literals).

- Never put ephemeral identifiers in code comments — PRD, ADR, PR, commit, issue, or "slice" numbers. Do not explain how the code worked previously.

- Compose complex function out of multiple pure functions, each focused on one operation on the immutable arguments.

- Keep functions under 50 lines.

- Extract magic numbers to named constants.

## Styling

- Never write a raw color literal in code.
