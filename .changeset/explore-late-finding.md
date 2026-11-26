---
"e2e": patch
---

`e2e explore` keeps a finding on the step it was reported in when that step ends at its deadline while the finding's screenshot is still being saved, in the terminal output and in the report, and no longer records a finding that arrives after the exploration is over.
