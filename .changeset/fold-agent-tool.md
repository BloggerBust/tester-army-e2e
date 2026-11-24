---
'@e2e-dev/mobile': patch
---

`foldTools(...engines)` from `@e2e-dev/mobile/tools` gives an agent a `fold` tool that puts a foldable device (the iPhone Duo simulator or a foldable Android emulator) in the `closed`, `half-open`, or `open` pose, as `device.fold` does in a test. With it in the agent's `tools`, `agent.act`, `e2e explore`, and the MCP server's `call` can fold and unfold the device. Spread it beside `mobileTools`. Like `tvTools`, it is offered by platform: when a device without a hinge shares the foldable's platform, put it on a named agent that the foldable tests select.
