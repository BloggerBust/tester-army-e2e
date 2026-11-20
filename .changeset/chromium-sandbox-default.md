---
"@e2e-dev/web": minor
---

**Release:** Chromium launches with its OS sandbox on by default on macOS and Windows, which helps contain a renderer exploit on a page the agent reaches. `web({ chromiumSandbox })` turns it on for Linux, where it stays off by default, or off elsewhere.
