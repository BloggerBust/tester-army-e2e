import { appleUserDefaults, type EngineAppInfo } from '@e2e-dev/core/engine';

export function launchArgumentList(app: Pick<EngineAppInfo, 'launchArguments' | 'launchArgumentValues'>): readonly string[] {
  const launchArguments = app.launchArgumentValues ?? app.launchArguments;
  return launchArguments === undefined ? [] : appleUserDefaults(launchArguments);
}
