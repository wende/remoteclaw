import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteClawServer } from './mcp-server.js';
import { ToolInvoker } from './tool-invoker.js';
import { OpenClawClient } from './openclaw-client.js';
import { TaskManager } from './task-manager.js';
import { NativeToolHandler, nativeToolDefinitions } from './native-tools.js';
import { discoverToolsDynamic } from './tool-discovery.js';
import type { PluginApi, AgentTool } from './types.js';

export { createRemoteClawServer } from './mcp-server.js';
export { ToolInvoker } from './tool-invoker.js';
export { OpenClawClient } from './openclaw-client.js';
export { TaskManager } from './task-manager.js';
export { NativeToolHandler, nativeToolDefinitions } from './native-tools.js';
export { agentToolsToMcpTools, findOpenClawRoot, discoverToolsDynamic } from './tool-discovery.js';
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

const DEFAULT_PORT = 3100;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createRemoteClawServer>;
}

export function register(api: PluginApi) {
  const config = api.pluginConfig ?? {};
  const gatewayUrl = (config.gatewayUrl as string) ?? 'http://localhost:18789';
  const gatewayToken = config.gatewayToken as string | undefined;
  const sessionKey = (config.sessionKey as string) ?? 'main';
  const port = (config.port as number) ?? DEFAULT_PORT;

  let httpServer: ReturnType<typeof createHttpServer> | null = null;
  let nativeHandler: NativeToolHandler | null = null;
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
    const server = createRemoteClawServer({
      tools,
      invoker: invoker!,
      nativeHandler: nativeHandler!,
      extraTools: nativeToolDefinitions,
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
      // Try dynamic discovery first (imports createOpenClawTools from gateway process),
      // fall back to static tool-catalog.json.
      try {
        tools = await discoverToolsDynamic({
          pluginConfig: config,
          loadConfig: api.runtime?.config?.loadConfig,
        });
        console.error(`[remoteclaw] Discovered ${tools.length} tools dynamically`);
      } catch (err) {
        console.error(`[remoteclaw] Dynamic discovery unavailable (${err}), using static catalog`);
        tools = loadToolCatalog();
        if (tools.length === 0) {
          console.error('[remoteclaw] No tools found in catalog. Run: npm run refresh-catalog');
        } else {
          console.error(`[remoteclaw] Loaded ${tools.length} tools from catalog`);
        }
      }

      invoker = new ToolInvoker(gatewayUrl, gatewayToken, sessionKey);
      const openclawClient = new OpenClawClient(gatewayUrl, gatewayToken);
      const taskMgr = new TaskManager();
      nativeHandler = new NativeToolHandler(openclawClient, taskMgr);

      const handler = async (req: IncomingMessage, res: ServerResponse) => {
        const proto = tls ? 'https' : 'http';
        const url = new URL(req.url ?? '/', `${proto}://localhost:${port}`);

        if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, tools: tools.length, sessions: sessions.size, tls: !!tls }));
          return;
        }

        if (url.pathname !== '/mcp') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        // Route to existing session or create new one
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
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
          await session.transport.handleRequest(req, res);
          return;
        }

        // New session: create Server + Transport pair
        const session = createSession();
        await session.server.connect(session.transport);
        await session.transport.handleRequest(req, res);

        // After handling, the transport now has a session ID
        const newSid = session.transport.sessionId;
        if (newSid) {
          sessions.set(newSid, session);
          console.error(`[remoteclaw] New session ${newSid} (${sessions.size} active)`);
        }
      };

      const tls = loadTlsOptions(config);
      httpServer = tls
        ? createHttpsServer({ cert: tls.cert, key: tls.key }, handler)
        : createHttpServer(handler);

      await new Promise<void>((resolve, reject) => {
        httpServer!.listen(port, '127.0.0.1', () => resolve());
        httpServer!.on('error', reject);
      });

      const proto = tls ? 'https' : 'http';
      console.error(`[remoteclaw] MCP server listening on ${proto}://127.0.0.1:${port}/mcp`);
    },

    async stop() {
      if (nativeHandler) {
        nativeHandler.stop();
        nativeHandler = null;
      }
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
