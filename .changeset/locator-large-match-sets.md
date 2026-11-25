---
'@e2e-dev/core': patch
---

A locator with more than 2048 matches can now be read as a set. Before, `allTextContents()`, the list matchers such as `toHaveText([...])`, and screenshot masks retried until their timeout and then failed, because the session's located-ref bound evicted the first refs of the same locate and every read of them was stale. The bound is now the larger of 2048 and the newest locate's match count, so a locate keeps all of its own refs and older ones are still pruned.
