---
"@e2e-dev/lightpanda": patch
---

`lightpanda()` loads linked stylesheets by default: `loadResources` defaults to `['stylesheet']` instead of `[]`. Without them, a node an external stylesheet hides counts as visible, so a visible query or an agent step can find a closed menu. A list still replaces the default, and `loadResources: []` fetches none, as before.
