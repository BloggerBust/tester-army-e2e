import type { ResolvedConfig } from '@e2e-dev/core/lib/config/resolve';
import { secretHandle } from '@e2e-dev/core/lib/secrets';
import type { AgentParams } from '@e2e-dev/core/lib/types';
import type { TestLineFills } from './test-lines.ts';

/** Every configured secret, including credential passwords, declared in the session step. */
export function sessionSecretParams(config: ResolvedConfig): AgentParams | undefined {
  if (config.allSecrets.size === 0) {
    return undefined;
  }

  return Object.fromEntries([...config.allSecrets.values()].map((secret) => [secret.name, secretHandle(secret)]));
}

/** The credentials and secret names used in test lines. */
export function sessionFills(config: ResolvedConfig): TestLineFills {
  return {
    credentials: [...config.credentials.values()].map((credential) => ({
      name: credential.name,
      username: credential.username,
      password: credential.password.name,
    })),
    secrets: [...config.secrets.keys()],
  };
}

/** Lists the configured credentials and secret names in a session opening. */
export function sessionSecretLines(config: ResolvedConfig): string[] {
  const lines: string[] = [];

  if (config.credentials.size > 0) {
    const described = [...config.credentials.values()].map(
      (credential) => `"${credential.name}" (username ${JSON.stringify(credential.username)}, password secret "${credential.password.name}")`,
    );
    lines.push(`Credentials: ${described.join(', ')}. Type the username with type; fill the password with type_secret and its password secret's name.`);
  }

  if (config.secrets.size > 0) {
    lines.push(`Secrets: ${[...config.secrets.keys()].map((name) => `"${name}"`).join(', ')}. Fill one with type_secret and its name.`);
  }

  return lines;
}
