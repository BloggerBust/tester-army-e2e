/** Compile-time assertions for the handle `mobile()` returns: named by this package, accepted wherever an engine handle is. */
import type { EngineHandle, ViewportSize as CoreViewportSize } from '@e2e-dev/core/engine';
import { mobile, type Device, type MobileEngine, type MobileFixtures, type ViewportSize } from '../../src/index.ts';
import type { Device as EntryDevice, MobileEngine as EntryMobileEngine, RemoteKey, ViewportSize as EntryViewportSize } from '../../src/engine-entry.ts';

void (mobile({ platform: 'ios' }) satisfies MobileEngine);
void (mobile({ platform: 'ios' }) satisfies EngineHandle<MobileFixtures>);
declare const handle: EngineHandle<MobileFixtures>;
void (handle satisfies MobileEngine);
void (handle satisfies EntryMobileEngine);
void (mobile({ platform: 'ios' }).platform satisfies 'ios' | undefined);
void (mobile({ platform: 'android' }).isolation satisfies 'worker' | undefined);
// @ts-expect-error an iOS handle isn't an Android one
void (mobile({ platform: 'ios' }).platform satisfies 'android' | undefined);

declare const device: Device;
declare const entryDevice: EntryDevice;
declare const fixtures: MobileFixtures;
void (device.viewport() satisfies Promise<ViewportSize>);
void (entryDevice.viewport() satisfies Promise<ViewportSize>);
void (fixtures.device.viewport() satisfies Promise<ViewportSize>);

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
void (true satisfies Exact<ReturnType<Device['viewport']>, Promise<ViewportSize>>);
void (true satisfies Exact<ViewportSize, CoreViewportSize>);
void (true satisfies Exact<EntryViewportSize, ViewportSize>);
declare const viewport: Awaited<ReturnType<Device['viewport']>>;
void (viewport.width satisfies number);
void (viewport.height satisfies number);
// @ts-expect-error viewport is a read with no options or dimensions to set.
device.viewport({ width: 390, height: 844 });
// @ts-expect-error viewport dimensions are readonly.
viewport.width = 400;
// @ts-expect-error viewport dimensions are readonly.
viewport.height = 800;

void device.pressRemote('menu');
// @ts-expect-error pressRemote takes the lowercase remote keys, not the keyboard's capitalised names
void device.pressRemote('Menu');
void ('play-pause' satisfies RemoteKey);
