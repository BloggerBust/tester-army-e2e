---
'@e2e-dev/web': patch
---

`press` with a single character that is not on a US keyboard (`é`, `ß`, `€`, `中`, an emoji) presses it in Chromium instead of failing with `ENGINE_FAILURE: Unknown key`. The page gets `keydown`, `input`, and `keyup` as for any key, and modifiers work (`Control+é`). In Firefox and WebKit it fails as `UNSUPPORTED_CAPABILITY` before any key is sent, where it used to leave the modifier held.
