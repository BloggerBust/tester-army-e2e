---
'e2e': patch
'@e2e-dev/core': patch
---

`expect(locator, message)`, `expect(screen, message)`, and their `expect.soft` forms take an optional message, as value expectations already do. It opens every assertion failure, `.not` and `toHaveScreenshot` included, and a locator's `LOCATOR_AMBIGUOUS` error: `the cart is empty: expect.toBeVisible failed`.
