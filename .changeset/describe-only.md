---
"e2e": patch
---

Add `test.describe.only(title, fn)` and the `only` option on `describe`, which focus every test in the group the way `test.only` focuses one. As in Playwright, a `test.only` or `describe.only` inside a focused group narrows the focus to it. A skipped test in a focused group keeps its own skip cause, and CI rejects a focused group with `ONLY_IN_CI`.
