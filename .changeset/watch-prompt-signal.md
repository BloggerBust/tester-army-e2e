---
"e2e": patch
---

A SIGTERM or SIGINT sent to `e2e run --watch` while the `p` or `t` filter prompt is open now closes the prompt and ends the session, as Ctrl-C typed into the prompt already did. Before, the session kept waiting for an answer. Ctrl-D in the prompt, and a Ctrl-C that arrives in the same read as `p` or `t` (a paste), end the session too.
