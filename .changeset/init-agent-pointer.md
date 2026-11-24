---
'e2e': patch
---

`e2e init` adds a line to `AGENTS.md` and `CLAUDE.md` that points coding agents at the installed skill, creating the file when it is missing. A file that already names the skill stays as it is, and `--skills none` writes neither.
