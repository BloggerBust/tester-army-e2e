/** Compile-time assertions for the handle `mobile()` returns: named by this package, accepted wherever an engine handle is. */
import type { EngineHandle } from '@e2e-dev/core/engine';
import { mobile, type MobileEngine, type MobileFixtures } from '../../src/index.ts';
import type { MobileEngine as EntryMobileEngine } from '../../src/engine-entry.ts';

void (mobile({ platform: 'ios' }) satisfies MobileEngine);
void (mobile({ platform: 'ios' }) satisfies EngineHandle<MobileFixtures>);
declare const handle: EngineHandle<MobileFixtures>;
void (handle satisfies MobileEngine);
void (handle satisfies EntryMobileEngine);
