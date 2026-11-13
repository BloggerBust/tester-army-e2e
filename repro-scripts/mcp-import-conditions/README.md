# MCP loads the `require` entry of a named engine

This repro compares Node's native import behavior with MCP session loading, demonstrating that the MCP server selects the wrong entry.

## Requirements

Node.js `^22.22.3 || >=24.8.0` and npm.

## Reproduce

From the repository root:

```sh
cd repro-scripts/mcp-import-conditions
npm install
npm run reproduce
```

## Expected

Native import and both MCP sessions load the ESM entry successfully. The script exits with code `0`.

## Actual

Native import and the MCP control succeed, but the named-engine session fails with `INVALID_CONFIG` and `REQUIRE_ENTRY_SELECTED`. The script exits with code `1`. Exit code `2` indicates an unrelated setup or protocol failure.
