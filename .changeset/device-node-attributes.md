---
"@e2e-dev/mobile": patch
---

`getAttribute()` and `toHaveAttribute()` read `label`, `resource-id`, `class`, and, on Android, `content-desc` on a device node, the names an Appium suite asks for (`label` is the accessibility label, on Android the text when there is no content description; `resource-id` and `class` also stand in for iOS `name` and `type`). Before, a device node carried only `placeholder`.
