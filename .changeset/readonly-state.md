---
"@e2e-dev/core": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Report a `readonly` node state where a node can be read-only. The web engine follows Playwright's rules for native controls and `aria-readonly`, using e2e's roles and the disabled state reported by `toBeEnabled()`; the mobile engine reports it on an Android text field or combobox, where the platform says whether the field takes text. iOS reports no such fact, so an iOS field has no state.

The web and mobile engines now need `@e2e-dev/core` and `e2e` 0.25.0 or later, since they emit a contract field that is new in 0.25.0. `toBeEditable` needs the engine releases that ship with this change: an older engine reports no read-only state. Agent observations and the MCP catalog now show `[readonly]` on such nodes, so the model can see a field it can't type into.
