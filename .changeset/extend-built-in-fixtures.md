---
'e2e': patch
'@e2e-dev/core': patch
---

`test.extend()` can extend a fixture the `test` already has, a built-in one included: `base.extend({ device: async ({ device }, use) => { await device.setPermission('camera', 'deny'); await use(device); } })`. Inside the function the fixture's own name is the fixture it extends (the built-in, or an earlier fixture of that name), and tests, hooks, and other fixtures that name it get the value passed to `use`. It keeps the type, the scope, and the `auto` of the fixture it extends on the target, so a `device` override on a mobile target runs once per worker and reaches `beforeAll`, and an override of an `auto` fixture is set up for every test; a `scope` or an `auto` that differs is a `COLLECTION_ERROR` naming both. On a target without that built-in, nothing fails until code that runs there names it.

A fixture named like a core fixture (`agent`, `app`, `screen`, `platform`, `session`), like one the target's engine contributes, or like one an earlier `extend` defined was refused before (`COLLECTION_ERROR`, or `TEST_SETUP_FAILED` in the test).
