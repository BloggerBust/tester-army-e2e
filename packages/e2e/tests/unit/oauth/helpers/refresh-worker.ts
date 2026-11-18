/**
 * One worker process for the cross-process refresh test: it makes one call
 * over the login stored in the file at argv[2], refreshing against the token
 * endpoint at argv[3], and prints the status the API at argv[4] answered.
 */

import { createOAuthFetch } from '../../../../src/oauth/fetch.ts';
import { FileCredentialStore } from '../../../../src/oauth/store.ts';
import { expiryFrom, requestTokens } from '../../../../src/oauth/token-endpoint.ts';
import type { OAuthCredentials } from '../../../../src/oauth/types.ts';

const [file, tokenUrl, apiUrl] = process.argv.slice(2) as [string, string, string];

const fetch = createOAuthFetch<OAuthCredentials>(
  {
    id: 'test',
    name: 'Test',
    async login() {
      throw new Error('not used');
    },
    async refresh(credentials) {
      const tokens = await requestTokens('Test', tokenUrl, { grant_type: 'refresh_token', refresh_token: credentials.refresh }, 'LOGIN_REQUIRED');
      return { access: tokens.access_token, refresh: tokens.refresh_token ?? '', expires: expiryFrom(tokens.expires_in) };
    },
  },
  { store: new FileCredentialStore(file), userAgent: 'test' },
);

const response = await fetch(apiUrl);
process.stdout.write(String(response.status));
