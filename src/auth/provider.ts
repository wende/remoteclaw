/**
 * MCP OAuth Server Provider for RemoteClaw
 *
 * Implements OAuthServerProvider from the MCP SDK to provide
 * a full OAuth 2.1 flow (authorization code + PKCE) that
 * Claude.ai and MCP Inspector can use to authenticate.
 *
 * Pre-configured client credentials come from plugin config.
 * Dynamic client registration is disabled — only the pre-configured
 * client can authenticate. The pre-configured client accepts any redirect_uri
 * (it's added to the allowlist on first use by the SDK authorize handler).
 */

import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

// --- Configuration ---

export interface AuthProviderConfig {
  /** Pre-configured client ID */
  clientId?: string;
  /** Pre-configured client secret */
  clientSecret?: string;
  /** Allowed redirect URIs. When empty/undefined, any redirect_uri is accepted. */
  redirectUris?: string[];
}

// --- Clients Store ---

interface CodeData {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface TokenData {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// An array that says "yes" to any .includes() check.
// The SDK authorize handler validates redirect_uri against client.redirect_uris.includes().
// For the pre-configured client we accept any redirect_uri since the real auth
// gate is the client_secret (verified during token exchange).
const ALLOW_ANY_REDIRECT: string[] = new Proxy([] as string[], {
  get(target, prop) {
    if (prop === 'includes') return () => true;
    if (prop === 'length') return 1; // SDK checks length === 1 when redirect_uri is omitted
    return Reflect.get(target, prop);
  },
});

/**
 * In-memory clients store. Only the pre-configured client is allowed.
 * Dynamic client registration is intentionally disabled.
 */
export class OpenClawClientsStore implements OAuthRegisteredClientsStore {
  private client: OAuthClientInformationFull | undefined;

  constructor(config: AuthProviderConfig) {
    if (config.clientId && config.clientSecret) {
      const redirectUris: string[] =
        config.redirectUris && config.redirectUris.length > 0
          ? config.redirectUris
          : ALLOW_ANY_REDIRECT;

      this.client = {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'RemoteClaw MCP Client',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
    }
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (this.client && this.client.client_id === clientId) {
      return this.client;
    }
    return undefined;
  }
}

// --- Auth Provider ---

/**
 * OAuth server provider for RemoteClaw MCP.
 *
 * Auto-approves authorization requests (no consent screen) since this
 * is a single-purpose MCP server where the user already controls credentials.
 */
export class OpenClawAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OpenClawClientsStore;

  private codes = new Map<string, CodeData>();
  private tokens = new Map<string, TokenData>();
  private refreshTokens = new Map<
    string,
    { clientId: string; scopes: string[]; expiresAt: number; resource?: URL }
  >();
  private reaperInterval: ReturnType<typeof setInterval> | undefined;

  constructor(config: AuthProviderConfig) {
    this.clientsStore = new OpenClawClientsStore(config);
    this.reaperInterval = setInterval(() => this.reapExpired(), REAPER_INTERVAL_MS);
    if (this.reaperInterval.unref) {
      this.reaperInterval.unref();
    }
  }

  /**
   * Stop the reaper interval. Call this on plugin stop() to prevent leaks.
   */
  dispose(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = undefined;
    }
  }

  reapExpired(): void {
    const now = Date.now();

    for (const [code, data] of this.codes) {
      if (now - data.createdAt > AUTH_CODE_TTL_MS) {
        this.codes.delete(code);
      }
    }

    for (const [token, data] of this.tokens) {
      if (data.expiresAt < now) {
        this.tokens.delete(token);
      }
    }

    for (const [token, data] of this.refreshTokens) {
      if (data.expiresAt < now) {
        this.refreshTokens.delete(token);
      }
    }
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const code = randomUUID();

    this.codes.set(code, { client, params, createdAt: Date.now() });

    const searchParams = new URLSearchParams({ code });
    if (params.state !== undefined) {
      searchParams.set('state', params.state);
    }

    const targetUrl = new URL(params.redirectUri);
    targetUrl.search = searchParams.toString();
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || Date.now() - codeData.createdAt > AUTH_CODE_TTL_MS) {
      if (codeData) this.codes.delete(authorizationCode);
      throw new InvalidRequestError('Invalid authorization code');
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData || Date.now() - codeData.createdAt > AUTH_CODE_TTL_MS) {
      if (codeData) this.codes.delete(authorizationCode);
      throw new InvalidRequestError('Invalid authorization code');
    }

    if (codeData.client.client_id !== client.client_id) {
      throw new InvalidRequestError('Authorization code was not issued to this client');
    }

    this.codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const scopes = codeData.params.scopes || [];

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      resource: resource || codeData.params.resource,
    });

    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: resource || codeData.params.resource,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const data = this.refreshTokens.get(refreshToken);
    if (!data || data.expiresAt < Date.now()) {
      if (data) this.refreshTokens.delete(refreshToken);
      throw new InvalidRequestError('Invalid refresh token');
    }

    if (data.clientId !== client.client_id) {
      throw new InvalidRequestError('Refresh token was not issued to this client');
    }

    // Revoke old refresh token (rotation)
    this.refreshTokens.delete(refreshToken);

    const accessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const tokenScopes = scopes || data.scopes;

    this.tokens.set(accessToken, {
      token: accessToken,
      clientId: client.client_id,
      scopes: tokenScopes,
      expiresAt: Date.now() + TOKEN_TTL_MS,
      resource: resource || data.resource,
    });

    this.refreshTokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: tokenScopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: resource || data.resource,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: TOKEN_TTL_MS / 1000,
      refresh_token: newRefreshToken,
      scope: tokenScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenData = this.tokens.get(token);
    if (!tokenData || tokenData.expiresAt < Date.now()) {
      throw new InvalidTokenError('Invalid or expired token');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource,
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.tokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }
}
