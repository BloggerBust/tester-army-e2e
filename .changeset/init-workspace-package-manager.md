---
'e2e': patch
---

`e2e init` in a workspace member with no `packageManager` field or lockfile of its own installs with its workspace root's package manager, so `npx e2e init --install` in a pnpm, Yarn, or Bun workspace no longer runs `npm install` and leaves a stray `package-lock.json`. When that manager is not installed, init warns and uses the invoking manager as before.
