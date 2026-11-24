---
'@e2e-dev/web': patch
---

`e2e doctor` now fails the `browser` check on Linux when the installed chromium or firefox cannot resolve its system libraries, instead of reporting a run can start. The message names the missing libraries and the fix, `npx @e2e-dev/web install <name> --with-deps` (pnpm: `pnpm exec e2e-web install <name> --with-deps`), and a launch that fails for the same reason says the same ahead of its own error.
