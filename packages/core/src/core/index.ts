/**
 * `@e2e-dev/core`: drive a browser or a device from plain code. No test
 * runner, config file, report, or `expect`. The agent is
 * `@e2e-dev/core/agent`, so this entry never loads the AI SDK. The test
 * runner, `e2e`, is built on it.
 */

export { launch, type CoreFixtures, type Host, type LaunchApp, type LaunchOptions, type NewSessionOptions, type Session, type SessionControls } from './launch.ts';
export { SessionState, type SessionStateKeyOptions } from './state.ts';
export { ConfigurationError, isE2EError, type ErrorCategory, type ErrorDetails } from '../internal/errors.ts';
export type { EngineHandle } from '../engine/index.ts';
export type {
  ActionOptions,
  App,
  AppPermissionState,
  ClickOptions,
  Expectable,
  FilePayload,
  JsonPrimitive,
  JsonValue,
  KeyModifier,
  LaunchArgumentValue,
  LaunchArguments,
  Locator,
  LongPressOptions,
  Point,
  PressSequentiallyOptions,
  RecordedVideo,
  RecordedVideoFile,
  RecordedVideoLink,
  RecordingOptions,
  Role,
  RoleAlias,
  RoleOptions,
  ScrollDirection,
  Screen,
  ScreenCoordinate,
  ScreenPoint,
  Secret,
  SelectOption,
  SwipeOptions,
  SwipePathOptions,
  TapOptions,
  TextMatch,
  TextMatchOptions,
  WebResponse,
} from '../types.ts';
