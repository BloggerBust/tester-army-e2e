---
'@e2e-dev/web': patch
---

Implicit rows, cells, and list items under a non-conflicted `role="presentation"` or `role="none"` table or list now inherit that presentational role in the tree, matching Chrome and Playwright; explicit child roles remain unchanged.
