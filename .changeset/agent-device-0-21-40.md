---
"@e2e-dev/mobile": patch
"@e2e-dev/e2b": patch
"@e2e-dev/limrun": patch
"@e2e-dev/revyl": patch
"@e2e-dev/testmu": patch
---

Update agent-device to 0.21.40. On iOS, `device.dismissKeyboard()` no longer presses the keyboard's Hide Keyboard or Done key: an iPad keyboard now goes away by the same short drag as an iPhone one. Pressing Enter sends one Return to the focused input, a fill reaches only the input a tap at that point reaches, and a command on a session whose simulator was deleted fails at once instead of waiting about 20 seconds.
