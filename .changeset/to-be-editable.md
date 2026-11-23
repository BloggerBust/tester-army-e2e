---
"e2e": patch
---

Add `expect(locator).toBeEditable()`, which waits for an enabled control that is not read-only. `{ editable: false }` waits for a disabled or read-only one.
