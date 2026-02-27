import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { OpenClawAuthProvider, OpenClawClientsStore } from '../auth/provider.js';

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';

function makeProvider(config = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }) {
  return new OpenClawAuthProvider(config);
}

function makeRedirectRes() {
  let redirectUrl = '';
  return {
    redirect: (url: string) => { redirectUrl = url; },
    get redirectUrl() { return redirectUrl; },
  };
}

async function doAuthorize(provider: OpenClawAuthProvider, state?: string) {
  const client = await provider.clientsStore.getClient(CLIENT_ID);
  if (!client) throw new Error('Client not found');

  const codeVerifier = randomUUID();
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const res = makeRedirectRes();
  await provider.authorize(
    client,
    {
      redirectUri: 'http://localhost/callback',
      codeChallenge,
      codeChallengeMethod: 'S256',
      state,
      scopes: ['mcp:tools'],
    } as any,
    res as any
  );

  const url = new URL(res.redirectUrl);
  const code = url.searchParams.get('code')!;

  return { code, codeVerifier, client };
}

describe('OpenClawClientsStore', () => {
  it('returns pre-configured client by ID', async () => {
    const store = new OpenClawClientsStore({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const client = await store.getClient(CLIENT_ID);
    expect(client).toBeDefined();
    expect(client!.client_id).toBe(CLIENT_ID);
  });

  it('returns undefined for unknown client', async () => {
    const store = new OpenClawClientsStore({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(await store.getClient('unknown')).toBeUndefined();
  });

  it('returns undefined when no credentials configured', async () => {
    const store = new OpenClawClientsStore({});
    expect(await store.getClient(CLIENT_ID)).toBeUndefined();
  });
});

describe('OpenClawAuthProvider', () => {
  let provider: OpenClawAuthProvider;

  beforeEach(() => {
    provider = makeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  it('authorize generates code and redirects with state', async () => {
    const res = makeRedirectRes();
    const client = await provider.clientsStore.getClient(CLIENT_ID);

    await provider.authorize(
      client!,
      {
        redirectUri: 'http://localhost/callback',
        codeChallenge: 'test-challenge',
        codeChallengeMethod: 'S256',
        state: 'my-state',
        scopes: [],
      } as any,
      res as any
    );

    const url = new URL(res.redirectUrl);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('my-state');
  });

  it('full OAuth flow: authorize → exchange → verify', async () => {
    const { code, codeVerifier, client } = await doAuthorize(provider, 'test-state');

    const tokens = await provider.exchangeAuthorizationCode(
      client, code, codeVerifier, 'http://localhost/callback'
    );

    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.token_type).toBe('bearer');

    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe(CLIENT_ID);
    expect(authInfo.scopes).toContain('mcp:tools');
  });

  it('rejects reused authorization code', async () => {
    const { code, codeVerifier, client } = await doAuthorize(provider);

    await provider.exchangeAuthorizationCode(client, code, codeVerifier);

    await expect(
      provider.exchangeAuthorizationCode(client, code, codeVerifier)
    ).rejects.toThrow('Invalid authorization code');
  });

  it('rejects code from different client', async () => {
    const { code, codeVerifier } = await doAuthorize(provider);

    const fakeClient = {
      client_id: 'other-client',
      client_secret: 'other-secret',
    } as any;

    await expect(
      provider.exchangeAuthorizationCode(fakeClient, code, codeVerifier)
    ).rejects.toThrow('not issued to this client');
  });

  it('refresh token rotation: old refresh token is invalidated', async () => {
    const { code, codeVerifier, client } = await doAuthorize(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, code, codeVerifier);

    const refreshed = await provider.exchangeRefreshToken(
      client, tokens.refresh_token!
    );
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    // Old refresh token should be invalid
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!)
    ).rejects.toThrow('Invalid refresh token');
  });

  it('refresh token from wrong client is rejected', async () => {
    const { code, codeVerifier, client } = await doAuthorize(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, code, codeVerifier);

    const fakeClient = { client_id: 'other', client_secret: 'x' } as any;
    await expect(
      provider.exchangeRefreshToken(fakeClient, tokens.refresh_token!)
    ).rejects.toThrow('not issued to this client');
  });

  it('verifyAccessToken rejects invalid token', async () => {
    await expect(
      provider.verifyAccessToken('nonexistent-token')
    ).rejects.toThrow('Invalid or expired token');
  });

  it('revokeToken removes access and refresh tokens', async () => {
    const { code, codeVerifier, client } = await doAuthorize(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, code, codeVerifier);

    await provider.revokeToken(client, { token: tokens.access_token } as any);
    await expect(
      provider.verifyAccessToken(tokens.access_token)
    ).rejects.toThrow();

    await provider.revokeToken(client, { token: tokens.refresh_token! } as any);
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!)
    ).rejects.toThrow();
  });

  it('reapExpired cleans up expired tokens', async () => {
    const { code, codeVerifier, client } = await doAuthorize(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, code, codeVerifier);

    // Verify token works
    await provider.verifyAccessToken(tokens.access_token);

    // Fast-forward expiry by mocking Date.now
    const future = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
    vi.spyOn(Date, 'now').mockReturnValue(future);

    provider.reapExpired();

    await expect(
      provider.verifyAccessToken(tokens.access_token)
    ).rejects.toThrow();

    vi.restoreAllMocks();
  });

  it('dispose clears the reaper interval', () => {
    const p = makeProvider();
    // Should not throw
    p.dispose();
    p.dispose(); // idempotent
  });

  it('challengeForAuthorizationCode returns code challenge', async () => {
    const client = await provider.clientsStore.getClient(CLIENT_ID);
    const codeVerifier = randomUUID();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const res = makeRedirectRes();
    await provider.authorize(
      client!,
      {
        redirectUri: 'http://localhost/callback',
        codeChallenge,
        codeChallengeMethod: 'S256',
        scopes: [],
      } as any,
      res as any
    );

    const url = new URL(res.redirectUrl);
    const authCode = url.searchParams.get('code')!;

    const challenge = await provider.challengeForAuthorizationCode(client!, authCode);
    expect(challenge).toBe(codeChallenge);
  });

  it('challengeForAuthorizationCode rejects invalid code', async () => {
    const client = await provider.clientsStore.getClient(CLIENT_ID);
    await expect(
      provider.challengeForAuthorizationCode(client!, 'bad-code')
    ).rejects.toThrow('Invalid authorization code');
  });
});
