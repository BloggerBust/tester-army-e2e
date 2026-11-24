---
"@e2e-dev/eas": patch
---

The install command now lists `e2e` and `@e2e-dev/mobile`. Installing `@e2e-dev/eas` alone left them out of `package.json`, and with pnpm `e2e.config.ts` could not import them.