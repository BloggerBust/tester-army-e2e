---
"e2e": minor
---

**Breaking:** A fixture that extends another fixture, such as an override of `device`, no longer takes its scope and `auto` from that fixture. Its scope and `auto` come from its options, like any other fixture.
