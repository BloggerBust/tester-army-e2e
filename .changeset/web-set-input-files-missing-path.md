---
"@e2e-dev/web": patch
---

`locator.setInputFiles` with a path that does not exist or sits under a directory the runner cannot search now fails as `INVALID_ARGUMENT`, a test error with exit code 1, before the engine clicks anything. Before, Playwright's `ENOENT` came back as infrastructure `ENGINE_FAILURE` with exit code 3, and a button that opens a file chooser was clicked first.
