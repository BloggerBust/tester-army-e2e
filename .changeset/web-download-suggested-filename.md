---
"@e2e-dev/web": patch
---

A browser provider's `downloads.read` gets the site's suggested file name as `context.suggestedFilename`, for a service that stores downloads by name rather than under the path the browser saved them to. `releaseEach` releases every lease a provider's `sweep` found at once and sorts them into released and failed, so a failed release never skips the others.
