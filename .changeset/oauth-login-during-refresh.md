---
"e2e": patch
---

A token refresh that finishes after `e2e login` or `e2e logout` no longer writes the old login's renewed tokens back over the new login, or back after the logout.
