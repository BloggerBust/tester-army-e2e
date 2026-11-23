---
'@e2e-dev/html-reporter': patch
---

The HTML report shows names as written instead of lowercasing them. A hook step's tag reads `beforeEach`, not `beforeeach`, and target names, test tags, session names, skip reasons, screen URLs, and token counts (`1.2M`, not `1.2m`) keep their casing too.
