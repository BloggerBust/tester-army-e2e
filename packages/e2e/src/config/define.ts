/**
 * Config file helpers. `defineConfig` keeps the config's inferred type and
 * types options that depend on other options in the config. `defineService`
 * defines a single service.
 */

import type { CopyableServiceValue, Service, ServiceMap, ServiceStartContext, ServiceValues } from '@e2e-dev/core/lib/types';
import type { E2EConfig } from '../run-types.ts';

/**
 * Returns `config` unchanged with its inferred type, so `typeof config` can
 * be a type argument of `test.extend`. Use it in place of
 * `satisfies E2EConfig` so options that depend on other options in the
 * config are typed.
 */
export function defineConfig<const Config extends E2EConfig<ServiceValues<Services>>, Services extends ServiceMap = {}>(
  config: Config & { readonly services?: Services } & { readonly [Key in Exclude<keyof Config, keyof E2EConfig>]: never },
): Config {
  return config;
}

/**
 * Returns `service` unchanged, preserving the inferred type that `start`
 * yields for both the config and tests. A yielded value that can't be copied
 * to tests is a type error.
 */
export function defineService<Value extends object>(
  service: Service<Value> & { start(context: ServiceStartContext): AsyncGenerator<NoInfer<CopyableServiceValue<Value>>, void, undefined> },
): Service<Value> {
  return service;
}
