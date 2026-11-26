---
'@e2e-dev/mobile': patch
---

Fix BrowserStack, TestMu AI, and Revyl runs on Windows failing during cleanup with `could not confirm its sessions ended` and leaving the device session open until idle timeout, and fail the release when any agent-device lease provider rejects ending the session (with the default `cleanupTimeout`).
