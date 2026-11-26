---
'e2e': patch
---

`open_session` over MCP no longer lists the first screen. Its reply ends with one line naming the screen (revision, path, node count), action results report changes against that screen, and `call {tool: "observe"}` lists its nodes. The server's instructions and the descriptions of its four tools are also shorter.
