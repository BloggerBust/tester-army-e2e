/** The helper a config file calls: `defineConfig`, which keeps the config's inferred type. */

import type { E2EConfig } from '../run-types.ts';

/**
 * Returns `config` as it is, with its inferred type, so `typeof config` can
 * type the fixtures of `test.extend`. A key that `E2EConfig` doesn't have
 * is a type error, as with `satisfies E2EConfig`.
 */
export function defineConfig<const Config extends E2EConfig>(
  config: Config & { readonly [Key in Exclude<keyof Config, keyof E2EConfig>]: never },
): Config {
  return config;
}
