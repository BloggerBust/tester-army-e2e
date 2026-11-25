---
'e2e': patch
---

A test or hook declared by a module a test file imports now reaches every test file and every retry. A worker imports a test file again after a failed test and for each file that shares the module, and the module registered its tests and hooks for the first import only: a second file that imported the same helper ran without the helper's `beforeEach`, and a helper's test ended with `disappeared on re-import`. Such a module, and each module that imports it, is now evaluated again with each test file that imports it. This holds for ES modules of the project on Node.js: a CommonJS module, a package from `node_modules`, and Bun keep one instance, as before.
