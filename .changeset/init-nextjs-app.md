---
"e2e": patch
---

`e2e init` now detects a Next.js app (`next` in `dependencies` or `devDependencies`) and writes a web target that starts it, so `npm run test:e2e` passes right after init with no edits. The target runs the `dev` script with the project's package manager and `reuseExisting: true`, on `http://localhost:<port>`, with the port from the `dev` script's `--port` or `-p` flag, else 3000. When the app has `build` and `start` scripts on the same port, CI runs `start` on the production build instead, and a pipeline from `--ci` runs `build` before the tests. Init prints the commands and the URL it used, and no longer asks for `APP_URL` in such a project. A Next.js app with no `dev` script, or with a port that is not a fixed number or that another command in the script sets, gets the same target as before and a warning. A project without `next` gets the same files as before.
