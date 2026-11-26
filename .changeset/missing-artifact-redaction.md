---
"@e2e-dev/core": patch
---

An artifact whose file could not be read now carries `redaction: 'incomplete'` instead of `complete`, matching the `report-1` schema for records without `path`, `size`, and `sha256`.
