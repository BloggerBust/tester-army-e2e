---
"e2e": patch
---

The `markdown` reporter and the trace pages escape an underscore at the edge of a word, so a test title or message holding `__proto__` or `_id_` shows as written instead of rendering bold or italic.
