---
'e2e': patch
---

`e2e init` and `e2e upgrade` leave alone the link pnpm 12.11 and later makes to the skill in the installed `e2e` package, without the "Symlink, not touching" warning. `init` no longer offers to replace it with a copy, and adds no copy where pnpm links the skill, in the project or at its workspace root. Both warn when a folder holds a copy and pnpm's `pnpm-e2e-e2e` link, which agents load as two `e2e` skills. Refreshing a copy now removes a file an earlier version shipped and the installed one doesn't; files you added stay.
