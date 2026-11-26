---
'@e2e-dev/mobile': patch
---

`device.lock()` and `device.unlock()` lock and unlock the screen of an Android 11 or newer device or an iOS simulator, each as a recorded step that returns once the device reports the new state. `unlock()` never enters a PIN, pattern, password, or passcode: a lock that asks for one is `UNSUPPORTED_CAPABILITY`, and so is a physical iPhone or iPad, a TV, and, for `lock()` on Android 16 or newer, a screen lock set to None. On Android 11 to 15, `lock()` with a screen lock set to None fails with `ENGINE_FAILURE`. On an iPhone simulator with an always-on display, such as the iPhone 17 Pro, `unlock()` can leave the display off. [device.lock](https://e2e.com/docs/reference/mobile#lock)
