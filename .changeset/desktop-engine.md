---
'@e2e-dev/desktop': patch
---

New package: `@e2e-dev/desktop`, the desktop engine. `engine: desktop()` drives a native app on macOS through agent-desktop's accessibility commands: observation, the `screen` locators and actions, test ids, secret fills over stdin, masked screenshots, and the `desktop` fixture. The app runs in the background and gets only a few variables of the run's environment. The engine downloads its pinned agent-desktop release on the first run.
