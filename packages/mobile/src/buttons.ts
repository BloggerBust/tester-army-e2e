/** A phone's hardware buttons, pressed through agent-device's `hardware-button`. */

import { TestError } from '@e2e-dev/core/engine';
import type { AgentDeviceClient } from './options.ts';
import type { DeviceSelection } from './bindings.ts';

type HardwareButtonName = Parameters<AgentDeviceClient['command']['hardwareButton']>[0]['button'];

/**
 * agent-device's button for each hardware button. agent-device sends them as
 * key events on an Android emulator or phone, and the volume buttons through
 * the XCUITest runner on a physical iPhone or iPad. An iOS simulator, an
 * Android TV, and an iPhone's or iPad's power button are refused, which
 * reaches the test as `UNSUPPORTED_CAPABILITY`. agent-device also has
 * `mute`, `sleep`, `wake`, and media keys; they are left out until a phone
 * test needs them.
 */
const HARDWARE_BUTTONS = {
  'volume-up': 'volume-up',
  'volume-down': 'volume-down',
  power: 'power',
} as const satisfies Record<string, HardwareButtonName>;

/** A hardware button `device.pressButton` takes. */
export type HardwareButton = keyof typeof HARDWARE_BUTTONS;

/** Every hardware button, in the order the docs list them. */
const HARDWARE_BUTTON_NAMES = Object.keys(HARDWARE_BUTTONS) as [HardwareButton, ...HardwareButton[]];

/**
 * Presses one hardware button on the selected device. The press takes the
 * input budget's signal, so when the budget runs out it cancels a request
 * the daemon has not sent yet, instead of letting a late `power` turn the
 * screen off.
 */
export function pressButton(client: AgentDeviceClient, button: HardwareButton, selection: DeviceSelection, signal: AbortSignal): Promise<unknown> {
  return client.command.hardwareButton({ ...selection, button: HARDWARE_BUTTONS[button], signal });
}

/** Throws `INVALID_ARGUMENT` unless `button` is one of the hardware buttons. */
export function requireHardwareButton(button: unknown): asserts button is HardwareButton {
  if (typeof button === 'string' && Object.hasOwn(HARDWARE_BUTTONS, button)) return;
  throw new TestError('INVALID_ARGUMENT', `device.pressButton(${JSON.stringify(button)}): not a hardware button; press one of ${HARDWARE_BUTTON_NAMES.join(', ')}`);
}
