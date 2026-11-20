---
'e2e': minor
'@e2e-dev/core': minor
---

**Breaking:** `report-1` reports can now contain the `skip.cause` value `fixme`.
Update pinned copies of `schema/report-v1.schema.json` from this release and
handle `fixme` in exhaustive skip-cause checks. The report's `schemaVersion`
stays `report-1`.

The new `test.fixme` API skips tests at registration or from inside their
bodies. The report gives the reason as `fixme`, or `fixme: <reason>` when you
give a non-blank reason.
