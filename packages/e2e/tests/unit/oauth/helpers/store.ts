import type { CredentialStore, OAuthCredentials } from '../../../../src/oauth/types.ts';

/** An in-memory store: the tests' way to hand a login to a constructor without a file. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, OAuthCredentials>();
  constructor(initial: Record<string, OAuthCredentials> = {}) {
    for (const [id, credentials] of Object.entries(initial)) this.entries.set(id, credentials);
  }
  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.entries.get(providerId);
  }
  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    this.entries.set(providerId, credentials);
  }
  async remove(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
  async replace(providerId: string, expected: OAuthCredentials, next: OAuthCredentials): Promise<boolean> {
    const stored = this.entries.get(providerId);
    if (stored?.access !== expected.access || stored.refresh !== expected.refresh) return false;
    this.entries.set(providerId, next);
    return true;
  }
  async list(): Promise<string[]> {
    return [...this.entries.keys()];
  }
  async exclusive<T>(_providerId: string, refresh: () => Promise<T>): Promise<T> {
    return refresh();
  }
}
