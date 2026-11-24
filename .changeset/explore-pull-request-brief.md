---
"e2e": patch
---

`e2e explore --changed-since` now gives the planner the pull request's title and description in a GitHub Actions `pull_request` job or a GitLab merge request pipeline, redacted and fenced like the commit messages, and never used to decide a skip.
