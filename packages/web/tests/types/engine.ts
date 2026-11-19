/** Compile-time assertions for the handle `web()` returns: named by this package, accepted wherever an engine handle is. */
import type { EngineHandle } from '@e2e-dev/core/engine';
import { web, type WebEngine, type WebFixtures } from '../../src/index.ts';
import type { WebEngine as EntryWebEngine } from '../../src/engine-entry.ts';

void (web() satisfies WebEngine);
void (web() satisfies EngineHandle<WebFixtures>);
declare const handle: EngineHandle<WebFixtures>;
void (handle satisfies WebEngine);
void (handle satisfies EntryWebEngine);
