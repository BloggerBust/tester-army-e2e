---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

Add `expect(locator).toBeEmpty()`, which waits for a node the engine reports empty. The web engine follows Playwright: an `input` or `textarea` is empty when its value is `''`, and any other element when its trimmed text content is, hidden text included. The mobile engine reads a text field by its value and any other node by the text and values in its subtree; on iOS, a field Flutter or Compose Multiplatform draws reads as a plain view, so its placeholder counts. Engines report the new `empty` node state on located nodes only, so agent observations are unchanged. The desktop engine and engine releases from before this one report no such state, so `toBeEmpty` fails there either way. On a secure field it is `POLICY_DENIED`.
