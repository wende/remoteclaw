import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { Request, Response, NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createRemoteClawServer } from './mcp-server.js';
import { ToolInvoker } from './tool-invoker.js';
import { OpenClawClient } from './openclaw-client.js';
import { TaskManager } from './task-manager.js';
import { NativeToolHandler, nativeToolDefinitions } from './native-tools.js';
import { SystemToolHandler, systemToolDefinitions } from './system-tools.js';
import { discoverToolsDynamic, discoverPluginToolsFromRegistry } from './tool-discovery.js';
import { OpenClawAuthProvider, type AuthProviderConfig } from './auth/provider.js';
import type { PluginApi, AgentTool } from './types.js';

export { createRemoteClawServer } from './mcp-server.js';
export { ToolInvoker } from './tool-invoker.js';
export { OpenClawClient } from './openclaw-client.js';
export { TaskManager } from './task-manager.js';
export { NativeToolHandler, nativeToolDefinitions } from './native-tools.js';
export { agentToolsToMcpTools, findOpenClawRoot, discoverToolsDynamic, discoverPluginToolsFromRegistry } from './tool-discovery.js';
export { mapToolResult, mapToolError, mapInvokeResponse } from './result-mapper.js';
export type { AgentTool, McpTool, ToolInvokeResponse, McpToolResult } from './types.js';

function loadToolCatalog(): AgentTool[] {
  const dir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

  const catalogPath = join(dir, 'tool-catalog.json');
  try {
    const raw = readFileSync(catalogPath, 'utf-8');
    return JSON.parse(raw) as AgentTool[];
  } catch {
    console.error(`[remoteclaw] Warning: could not load ${catalogPath}, using empty tool list`);
    return [];
  }
}

function resolvePluginDir(): string {
  return typeof __dirname !== 'undefined'
    ? resolve(__dirname, '..')
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function needsRebuild(): boolean {
  const pluginDir = resolvePluginDir();
  const srcDir = join(pluginDir, 'src');
  const distDir = join(pluginDir, 'dist');
  const distIndex = join(distDir, 'index.js');

  // If dist doesn't exist, we need to build
  if (!existsSync(distIndex)) {
    return true;
  }

  try {
    const distStat = statSync(distIndex);
    const srcStat = statSync(srcDir);
    // If src is newer than dist, rebuild
    return srcStat.mtime > distStat.mtime;
  } catch {
    // If we can't stat, assume rebuild is needed
    return true;
  }
}

function autoBuild(): void {
  if (!needsRebuild()) {
    return;
  }

  const pluginDir = resolvePluginDir();
  console.error('[remoteclaw] Source files changed, rebuilding...');
  try {
    execSync('npm run build', {
      cwd: pluginDir,
      stdio: 'inherit',
      timeout: 60000,
    });
    console.error('[remoteclaw] Build complete');
  } catch (err) {
    console.error(`[remoteclaw] Build failed: ${err}`);
    throw err;
  }
}

function loadTlsOptions(config: Record<string, unknown>): { cert: Buffer; key: Buffer } | null {
  const certPath = config.tlsCert as string | undefined;
  const keyPath = config.tlsKey as string | undefined;

  if (!certPath || !keyPath) {
    const pluginDir = resolvePluginDir();
    const autoCert = join(pluginDir, 'certs', 'localhost+2.pem');
    const autoKey = join(pluginDir, 'certs', 'localhost+2-key.pem');
    if (existsSync(autoCert) && existsSync(autoKey)) {
      console.error('[remoteclaw] Auto-detected TLS certs in certs/ directory');
      return { cert: readFileSync(autoCert), key: readFileSync(autoKey) };
    }
    return null;
  }

  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

function parseCorsOrigins(raw: string | undefined): { origins: string[]; enabled: boolean } {
  if (!raw || raw === '*') return { origins: ['*'], enabled: true };
  if (raw.toLowerCase() === 'none' || raw === '') return { origins: [], enabled: false };
  return {
    origins: raw.split(',').map((s) => s.trim()).filter(Boolean),
    enabled: true,
  };
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(1);
      try {
        const originHost = new URL(origin).hostname;
        return originHost === domain.slice(1) || originHost.endsWith(domain);
      } catch {
        return false;
      }
    }
    return origin === allowed || origin === `https://${allowed}` || origin === `http://${allowed}`;
  });
}

const DEFAULT_PORT = 3100;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createRemoteClawServer>;
}

export function register(api: PluginApi) {
  // Auto-rebuild if source files are newer than dist
  try {
    autoBuild();
  } catch (err) {
    console.error('[remoteclaw] Aborting plugin start due to build failure');
    throw err;
  }

  const config = api.pluginConfig ?? {};
  const gatewayUrl = (config.gatewayUrl as string) ?? 'http://localhost:18789';
  const gatewayToken = config.gatewayToken as string | undefined;
  const sessionKey = (config.sessionKey as string) ?? 'main';
  const port = (config.port as number) ?? DEFAULT_PORT;

  // Auth config
  const authEnabled = (config.authEnabled as boolean) ?? false;
  const clientId = config.clientId as string | undefined;
  const clientSecret = config.clientSecret as string | undefined;
  const issuerUrl = config.issuerUrl as string | undefined;
  const corsOrigins = config.corsOrigins as string | undefined;

  let httpServer: ReturnType<typeof createHttpServer> | null = null;
  let nativeHandler: NativeToolHandler | null = null;
  let systemToolHandler: SystemToolHandler | null = null;
  let authProvider: OpenClawAuthProvider | null = null;
  const sessions = new Map<string, Session>();

  // Shared deps created once, reused across sessions
  let invoker: ToolInvoker | null = null;
  let tools: AgentTool[] = [];

  // Register /tools/list HTTP route on the gateway for debugging and external consumers.
  if (typeof api.registerHttpRoute === 'function') {
    api.registerHttpRoute({
      path: '/tools/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405);
          res.end('Method Not Allowed');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tools));
      },
    });
  }

  function createSession(): Session {
    // Extract tool executors for direct invocation (from dynamic discovery with execute methods)
    const toolExecutors = new Map<string, (callId: string, args: Record<string, unknown>) => Promise<any>>();
    for (const tool of tools) {
      if (tool.execute && typeof tool.execute === 'function') {
        toolExecutors.set(tool.name, tool.execute);
      }
    }

    const server = createRemoteClawServer({
      tools,
      invoker: invoker!,
      nativeHandler: nativeHandler!,
      extraTools: [...nativeToolDefinitions, ...systemToolDefinitions],
      toolExecutors: toolExecutors.size > 0 ? toolExecutors : undefined,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        console.error(`[remoteclaw] Session ${sid} closed (${sessions.size} active)`);
      }
    };

    return { transport, server };
  }

  api.registerService({
    id: 'remoteclaw',

    async start() {
      // --- Validate auth config ---
      if (authEnabled && (!clientId || !clientSecret)) {
        throw new Error(
          '[remoteclaw] authEnabled is true but clientId/clientSecret are not set. ' +
          'Configure them in openclaw.json under plugins.remoteclaw.'
        );
      }

      // --- TLS (hoist early for issuer URL) ---
      const tls = loadTlsOptions(config);
      const proto = tls ? 'https' : 'http';

      // --- Create invoker early (needed for HTTP tool discovery) ---
      invoker = new ToolInvoker(gatewayUrl, gatewayToken, sessionKey);
      const openclawClient = new OpenClawClient(gatewayUrl, gatewayToken);

      // --- Tool discovery: HTTP → dynamic import → static catalog ---
      tools = await invoker.listTools();
      if (tools.length > 0) {
        console.error(`[remoteclaw] Discovered ${tools.length} tools from gateway`);
      } else {
        try {
          tools = await discoverToolsDynamic({
            pluginConfig: config,
            loadConfig: api.runtime?.config?.loadConfig,
          });
          console.error(`[remoteclaw] Discovered ${tools.length} tools dynamically`);
        } catch (err) {
          console.error(`[remoteclaw] Dynamic discovery unavailable (${err}), using static catalog`);
          tools = loadToolCatalog();
          console.error(`[remoteclaw] Loaded ${tools.length} tools from static catalog`);

          // Supplement with plugin tools from the gateway's active registry
          const pluginTools = discoverPluginToolsFromRegistry({ config: api.config });
          if (pluginTools.length > 0) {
            const existingNames = new Set(tools.map(t => t.name));
            const newTools = pluginTools.filter(t => !existingNames.has(t.name));
            tools = [...tools, ...newTools];
            console.error(`[remoteclaw] Added ${newTools.length} plugin tools from registry`);
          }
        }
      }
      const taskMgr = new TaskManager();
      systemToolHandler = new SystemToolHandler();
      nativeHandler = new NativeToolHandler(openclawClient, taskMgr, systemToolHandler);

      // --- Express app (replaces raw handler) ---
      const allowedHosts = ['127.0.0.1', 'localhost', '::1'];
      if (issuerUrl) {
        try { allowedHosts.push(new URL(issuerUrl).hostname); } catch {}
      }
      const app = createMcpExpressApp({ host: '127.0.0.1', allowedHosts });

      // --- CORS middleware (before auth so OPTIONS preflight works) ---
      const corsConfig = parseCorsOrigins(corsOrigins);
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (!corsConfig.enabled) {
          next();
          return;
        }

        const origin = req.headers.origin as string | undefined;
        const allowedOrigin = corsConfig.origins.includes('*')
          ? '*'
          : origin && isOriginAllowed(origin, corsConfig.origins)
            ? origin
            : undefined;

        if (allowedOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, Mcp-Session-Id, mcp-protocol-version'
          );
          res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
        }

        if (req.method === 'OPTIONS') {
          res.status(204).end();
          return;
        }

        next();
      });

      // --- OAuth routes (if auth enabled) ---
      let authMiddleware: ((req: Request, res: Response, next: NextFunction) => void) | undefined;

      if (authEnabled) {
        const authConfig: AuthProviderConfig = { clientId, clientSecret };
        authProvider = new OpenClawAuthProvider(authConfig);

        const issuer = issuerUrl
          ? new URL(issuerUrl)
          : new URL(`${proto}://127.0.0.1:${port}`);

        app.use(
          mcpAuthRouter({
            provider: authProvider,
            issuerUrl: issuer,
            scopesSupported: ['mcp:tools'],
          })
        );

        // Protected Resource Metadata (RFC 9728)
        app.get('/.well-known/oauth-protected-resource/:path', (req: Request, res: Response) => {
          res.json({
            resource: `${issuer.toString()}${req.params.path}`,
            authorization_servers: [issuer.toString().replace(/\/$/, '')],
            scopes_supported: ['mcp:tools'],
          });
        });

        authMiddleware = requireBearerAuth({ verifier: authProvider });

        console.error('[remoteclaw] OAuth 2.1 authentication ENABLED');
      }

      // --- Health check (no auth) ---
      app.get('/health', (_req: Request, res: Response) => {
        res.json({
          ok: true,
          tools: tools.length,
          sessions: sessions.size,
          tls: !!tls,
          auth: authEnabled,
        });
      });

      // Helper to conditionally apply auth middleware
      const withAuth = (handler: (req: Request, res: Response) => Promise<void>) => {
        if (authMiddleware) {
          return [authMiddleware, async (req: Request, res: Response) => handler(req, res)] as const;
        }
        return [async (req: Request, res: Response) => handler(req, res)] as const;
      };

      // --- MCP request handler ---
      const handleMcpRequest = async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            req.body
          );
          return;
        }

        if (sessionId && !sessions.has(sessionId)) {
          // Stale session (e.g. after gateway restart).
          // Auto-recover: create a new session, synthetic-init via web standard transport, then replay.
          console.error(`[remoteclaw] Stale session ${sessionId}, auto-recovering…`);
          const session = createSession();
          await session.server.connect(session.transport);

          // Access the internal web standard transport to send a synthetic init
          const wst = (session.transport as any)._webStandardTransport;

          const initBody = JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'remoteclaw-recovery', version: '0.1.0' },
            },
            id: `_init_${randomUUID()}`,
          });

          const initReq = new Request(`${proto}://localhost:${port}/mcp`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'accept': 'application/json, text/event-stream',
            },
            body: initBody,
          });

          // Send the init and discard response
          await wst.handleRequest(initReq, {});

          const newSid = session.transport.sessionId;
          if (newSid) {
            sessions.set(newSid, session);
            console.error(`[remoteclaw] Recovered → new session ${newSid}`);
          }

          // Forward the original request with the new session ID and protocol version
          delete req.headers['mcp-session-id'];
          if (newSid) req.headers['mcp-session-id'] = newSid;
          if (!req.headers['mcp-protocol-version']) {
            req.headers['mcp-protocol-version'] = '2025-03-26';
          }
          await session.transport.handleRequest(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            req.body
          );
          return;
        }

        // New session: create Server + Transport pair
        const session = createSession();
        await session.server.connect(session.transport);
        await session.transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body
        );

        // After handling, the transport now has a session ID
        const newSid = session.transport.sessionId;
        if (newSid) {
          sessions.set(newSid, session);
          console.error(`[remoteclaw] New session ${newSid} (${sessions.size} active)`);
        }
      };

      app.get('/mcp', ...withAuth(handleMcpRequest));
      app.post('/mcp', ...withAuth(handleMcpRequest));
      app.delete('/mcp', ...withAuth(handleMcpRequest));

      // --- Server creation ---
      httpServer = tls
        ? createHttpsServer({ cert: tls.cert, key: tls.key }, app)
        : createHttpServer(app);

      await new Promise<void>((resolve, reject) => {
        httpServer!.listen(port, '127.0.0.1', () => resolve());
        httpServer!.on('error', reject);
      });

      console.error(`[remoteclaw] MCP server listening on ${proto}://127.0.0.1:${port}/mcp`);
      if (!authEnabled) {
        console.error('[remoteclaw] Auth is DISABLED — server is open');
      }
    },

    async stop() {
      if (authProvider) {
        authProvider.dispose();
        authProvider = null;
      }
      if (nativeHandler) {
        nativeHandler.stop();
        nativeHandler = null;
      }
      systemToolHandler = null;
      // Close all sessions
      for (const [sid, session] of sessions) {
        await session.server.close();
        sessions.delete(sid);
      }
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = null;
      }
      invoker = null;
      console.error('[remoteclaw] MCP server stopped');
    },
  });
}
