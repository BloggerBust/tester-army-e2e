/**
 * Config file helpers: `defineConfig` preserves the config's inferred type,
 * and `defineService` defines a single service.
 */

import type { CopyableServiceValue, Service, ServiceStartContext } from '@e2e-dev/core/lib/types';
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

/**
 * Returns `service` unchanged, preserving the inferred type that `start` yields
 * for tests. A yielded value that can't be copied to tests is a type error.
 */
export function defineService<Value extends object>(
  service: Service<Value> & { start(context: ServiceStartContext): AsyncGenerator<NoInfer<CopyableServiceValue<Value>>, void, undefined> },
): Service<Value> {
  return service;
}
