---
"@e2e-dev/core": patch
"e2e": patch
---

A step whose label is longer than `report.json` allows, such as `app.open()` with a very long path, now has its label cut to 8,192 characters in `report.json`, so the report stays valid.
