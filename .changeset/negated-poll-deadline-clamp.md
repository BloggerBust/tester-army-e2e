---
'@e2e-dev/core': patch
---

A negated assertion such as `expect(locator).not.toBeVisible()` no longer counts time past its timeout toward how long the negation held. A last check that wakes late can no longer turn a too-short hold into a pass.
