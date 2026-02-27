/**
 * E2E test: full plugin lifecycle with OAuth 2.1.
 *
 * Exercises the real register() → start() → OAuth dance → MCP client → stop() path.
 * Mocks: discoverToolsDynamic (returns test tools), fetch (for gateway /tools/invoke).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Save the real fetch before anything touches it
const realFetch = globalThis.fetch;

// Allow self-signed TLS certs (the plugin auto-detects certs/ dir)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// --- Mock discoverToolsDynamic before importing register ---
// vi.mock factory is hoisted — cannot reference outer variables.

vi.mock('../tool-discovery.js', () => ({
  discoverToolsDynamic: vi.fn().mockResolvedValue([
    {
      name: 'echo',
      description: 'Echo back the input',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  ]),
  agentToolsToMcpTools: vi.fn().mockImplementation((tools: any[]) =>
    tools.map((t: any) => {
      const { type: _type, ...rest } = t.parameters;
      return { name: t.name, description: t.description, inputSchema: { ...rest, type: 'object' } };
    })
  ),
  findOpenClawRoot: vi.fn(),
}));

import { register } from '../index.js';

const CLIENT_ID = 'e2e-client';
const CLIENT_SECRET = 'e2e-secret-value';

interface CapturedService {
  id: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

function createMockApi(config: Record<string, unknown>) {
  let captured: CapturedService | null = null;

  const api = {
    pluginConfig: config,
    registerHttpRoute: vi.fn(),
    registerService: (svc: any) => {
      captured = svc;
    },
    runtime: { config: { loadConfig: vi.fn() } },
    get service() {
      return captured;
    },
  };

  return api;
}

/** Extract URL string from fetch's first argument (string, URL, or Request). */
function extractUrl(input: any): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

/** Create a fetch that intercepts gateway calls and delegates the rest to realFetch. */
function createGatewayMockFetch() {
  return async (input: any, init?: any) => {
    const url = extractUrl(input);
    if (url.includes('localhost:18789')) {
      const body = JSON.parse(init?.body ?? '{}');
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            content: [{ type: 'text', text: `echoed: ${body.args?.message ?? ''}` }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return realFetch(input, init);
  };
}

// Helper: run the OAuth dance and return an access token
async function getAccessToken(baseUrl: string): Promise<string> {
  const codeVerifier = randomUUID();
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  // Step 1: Authorize
  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', 'http://localhost/callback');
  authorizeUrl.searchParams.set('state', 'e2e');
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const authorizeRes = await realFetch(authorizeUrl.toString(), { redirect: 'manual' });
  const location = authorizeRes.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;

  // Step 2: Token exchange
  const tokenRes = await realFetch(`${baseUrl}/token`, {
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

  const tokens = (await tokenRes.json()) as any;
  return tokens.access_token;
}

// ========== Auth-enabled E2E ==========

describe('E2E: auth enabled', () => {
  let service: CapturedService;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = 30000 + Math.floor(Math.random() * 10000);
    const api = createMockApi({
      port,
      authEnabled: true,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });

    register(api as any);
    service = api.service!;

    // Stub fetch so ToolInvoker's gateway calls are intercepted
    vi.stubGlobal('fetch', createGatewayMockFetch());

    await service.start();
    // Server runs HTTPS due to auto-detected certs
    baseUrl = `https://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await service.stop();
    vi.unstubAllGlobals();
  });

  it('/health is accessible without auth', async () => {
    const res = await realFetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.auth).toBe(true);
  });

  it('/mcp returns 401 without Bearer token', async () => {
    const res = await realFetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('full flow: OAuth → MCP client → listTools → callTool', async () => {
    const accessToken = await getAccessToken(baseUrl);

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      fetch: createGatewayMockFetch() as typeof fetch,
    });

    const client = new Client({ name: 'e2e-test', version: '1.0.0' });
    await client.connect(transport);

    // List tools — should include our test tool + native tools
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('openclaw_chat');

    // Call a tool
    const result = await client.callTool({ name: 'echo', arguments: { message: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'echoed: hello' }]);

    await client.close();
  });
});

// ========== Auth-disabled E2E ==========

describe('E2E: auth disabled', () => {
  let service: CapturedService;
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = 30000 + Math.floor(Math.random() * 10000);
    const api = createMockApi({
      port,
      authEnabled: false,
    });

    register(api as any);
    service = api.service!;

    vi.stubGlobal('fetch', createGatewayMockFetch());

    await service.start();
    baseUrl = `https://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await service.stop();
    vi.unstubAllGlobals();
  });

  it('/health shows auth: false', async () => {
    const res = await realFetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.auth).toBe(false);
  });

  it('MCP client connects without any auth', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      fetch: createGatewayMockFetch() as typeof fetch,
    });

    const client = new Client({ name: 'e2e-noauth', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('echo');

    const result = await client.callTool({ name: 'echo', arguments: { message: 'noauth' } });
    expect(result.content).toEqual([{ type: 'text', text: 'echoed: noauth' }]);

    await client.close();
  });
});

// ========== Startup validation ==========

describe('E2E: startup validation', () => {
  it('rejects authEnabled without clientId/clientSecret', async () => {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const api = createMockApi({
      port,
      authEnabled: true,
    });

    register(api as any);

    await expect(api.service!.start()).rejects.toThrow('clientId/clientSecret are not set');
  });
});
