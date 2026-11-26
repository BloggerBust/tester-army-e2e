---
"@e2e-dev/core": patch
"e2e": patch
---

Allow `app.command.env` to be a function that receives the config's services. It's called after services start and before app commands start. With `defineConfig`, its `services` argument is typed from the config's `services`. The `CommandConfig['env']` type now includes the function, so code that reads it as an object of variables needs to handle a function too.
