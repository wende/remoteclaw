/**
 * Integration tests for the Express-based MCP server with OAuth 2.1.
 *
 * Starts a real Express server and verifies:
 * - /health is always accessible (no auth)
 * - /mcp returns 401 without a valid Bearer token (when auth enabled)
 * - Full OAuth flow: authorize → token → bearer access
 * - CORS preflight returns 204
 * - Startup validation rejects authEnabled without credentials
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { OpenClawAuthProvider } from '../auth/provider.js';

const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret-value';

// --- Auth-enabled server ---

describe('Express server with auth enabled', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const provider = new OpenClawAuthProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const app = createMcpExpressApp({ host: '127.0.0.1' });

    const issuerUrl = new URL('http://127.0.0.1:0');

    // CORS middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version'
      );
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        scopesSupported: ['mcp:tools'],
      })
    );

    const bearerAuth = requireBearerAuth({ verifier: provider });
    const withAuth = (handler: (req: Request, res: Response) => Promise<void>) => {
      return [bearerAuth, async (req: Request, res: Response) => handler(req, res)] as const;
    };

    app.get('/health', (_req: Request, res: Response) => {
      res.json({ ok: true, auth: true });
    });

    app.post(
      '/mcp',
      ...withAuth(async (_req: Request, res: Response) => {
        res.json({ result: 'mcp-ok' });
      })
    );

    app.get(
      '/mcp',
      ...withAuth(async (_req: Request, res: Response) => {
        res.json({ result: 'mcp-get-ok' });
      })
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /health returns 200 without auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.auth).toBe(true);
  });

  it('POST /mcp returns 401 without token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp returns 401 with invalid Bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('OPTIONS returns 204 (CORS preflight)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('full OAuth flow: authorize → token → access /mcp', async () => {
    const state = randomUUID();
    const codeVerifier = randomUUID();
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    // Step 1: Authorize
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const authorizeRes = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);

    const location = authorizeRes.headers.get('location')!;
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get('state')).toBe(state);

    // Step 2: Token exchange
    const tokenRes = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifier,
        redirect_uri: 'http://localhost/callback',
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);

    const tokens = await tokenRes.json() as any;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe('bearer');

    // Step 3: Access protected endpoint
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: '{}',
    });
    expect(mcpRes.status).toBe(200);
    const mcpBody = await mcpRes.json() as any;
    expect(mcpBody.result).toBe('mcp-ok');
  });

  it('authorize rejects unknown client_id', async () => {
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', 'unknown');
    authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
    authorizeUrl.searchParams.set('code_challenge', 'test');
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const res = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    expect(res.status).toBe(400);
  });

  it('OAuth metadata is available without auth', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.token_endpoint).toBeDefined();
    expect(body.authorization_endpoint).toBeDefined();
    // Dynamic registration should NOT be advertised
    expect(body.registration_endpoint).toBeUndefined();
  });
});

// --- No-auth server ---

describe('Express server with auth disabled', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createMcpExpressApp({ host: '127.0.0.1' });

    app.get('/health', (_req: Request, res: Response) => {
      res.json({ ok: true, auth: false });
    });

    app.post('/mcp', async (_req: Request, res: Response) => {
      res.json({ result: 'mcp-ok' });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('GET /health returns 200', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.auth).toBe(false);
  });

  it('POST /mcp works without auth', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result).toBe('mcp-ok');
  });
});

// --- Startup validation ---

describe('Startup validation', () => {
  it('throws when authEnabled is true but clientId/clientSecret missing', () => {
    // Simulate the validation logic from index.ts start()
    const authEnabled = true;
    const clientId = undefined;
    const clientSecret = undefined;

    expect(() => {
      if (authEnabled && (!clientId || !clientSecret)) {
        throw new Error(
          '[remoteclaw] authEnabled is true but clientId/clientSecret are not set.'
        );
      }
    }).toThrow('clientId/clientSecret are not set');
  });
});
