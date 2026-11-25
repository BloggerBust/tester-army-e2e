import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';

/**
 * How registration tells the module loader that the module at a path
 * registered a test or a hook while it was evaluating, whichever copy of e2e
 * either one is. The loader then evaluates that module again with every test
 * file that imports it (`esm-hooks.ts`, "Registrars"). Unset where no loader
 * runs.
 */
export const registrarModuleSlot = realmSlot<(file: string) => void>('e2e.registrar-module.v1');
