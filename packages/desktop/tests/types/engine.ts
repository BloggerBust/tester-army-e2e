/** Compile-time assertions for the handle `desktop()` returns. */
import { desktop } from '../../src/index.ts';

void (desktop().platform satisfies 'macos' | undefined);
void (desktop().isolation satisfies 'attempt' | undefined);
