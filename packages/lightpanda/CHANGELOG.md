# @e2e-dev/lightpanda

## 0.0.3

### Patch Changes

- [#1965](https://github.com/e2e-inc/e2e/pull/1965) [`60d29cf`](https://github.com/e2e-inc/e2e/commit/60d29cfe4c9d88b00659e0d0e00b8973d61e7391) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - List the maintainers' `@e2e.com` addresses in `contributors`.

- [#1923](https://github.com/e2e-inc/e2e/pull/1923) [`bc41a25`](https://github.com/e2e-inc/e2e/commit/bc41a25c7d7e6d6f62c5b78b516c0a1f71c2b45c) Thanks [@cdebled](https://github.com/cdebled)! - `lightpanda()` loads linked stylesheets by default: `loadResources` defaults to `['stylesheet']` instead of `[]`. Without them, a node an external stylesheet hides counts as visible, so a visible query or an agent step can find a closed menu. A list still replaces the default, and `loadResources: []` fetches none, as before.

## 0.0.2

### Patch Changes

- [#1672](https://github.com/e2e-inc/e2e/pull/1672) [`3735887`](https://github.com/e2e-inc/e2e/commit/373588756937562aa89c7dd7f7995ac6b16db972) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move GitHub repository metadata and CLI links to e2e-inc/e2e after the organization rename. Register the MCP server as io.github.e2e-inc/e2e.

## 0.0.1

### Patch Changes

- [#1163](https://github.com/tester-army/e2e/pull/1163) [`b41afa2`](https://github.com/tester-army/e2e/commit/b41afa262ec32a7e90d065a4624f69f8f4a22e4f) Thanks [@okwasniewski](https://github.com/okwasniewski)! - New package: `lightpanda()`, a browser provider that starts a `lightpanda serve` per worker slot on a free port and stops it when the run ends.
