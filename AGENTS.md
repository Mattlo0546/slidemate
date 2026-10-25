# Notes for coding agents

## Release notes (`.github/release-notes/vX.Y.Z.md`)

The installed app shows these notes in its **SlideMate X.Y.Z is available** dialog: a small plain-text alert that
strips Markdown, joins wrapped lines, stops at `### Install`, and cuts off after 900 characters. Write for that box
first; GitHub renders the same file, so it will look fine there too.

- **Under 700 characters** before the first `###` heading after `### New`. Read it as plain text with no bold.
- **One lead sentence** saying what the update does for the user. Nothing else above `### New`.
- **3–5 bullets** under `### New`, each one line: a bold short name, then one plain sentence. No nested lists, no
  parentheses chains, no "Settings → X → Y" paths unless that's the whole point of the bullet.
- Say what the user gets, not how it was built. No file names, flags, MCP, PR numbers or version internals.
- **No install, download, Gatekeeper or "Open Anyway" steps.** CI appends `installation.md` (under `### Install`)
  after your notes, and people seeing the dialog already have the app.
- Fixes go in an optional `### Fixed` section, one short line each, only if a user would notice.

Example:

```markdown
SlideMate 0.7 finds your slides faster and keeps lecture recordings in sync.

### New
- **Faster Pull.** Only new files download, so a Pull takes seconds.
- **Recordings follow your slides.** A lecture's recording opens beside its deck.
- **Search everything.** Find any word across your slides and notes.

### Fixed
- The sidebar no longer jumps when a file finishes downloading.
```
