import { createRemoteClawServer } from './mcp-server.js';
import { ToolInvoker } from './tool-invoker.js';
import type { PluginApi, AgentTool } from './types.js';

export { createRemoteClawServer } from './mcp-server.js';
export { ToolInvoker } from './tool-invoker.js';
export { agentToolsToMcpTools } from './tool-discovery.js';
export { mapToolResult, mapToolError, mapInvokeResponse } from './result-mapper.js';
export type { AgentTool, McpTool, ToolInvokeResponse, McpToolResult } from './types.js';

export function register(api: PluginApi) {
  const config = api.config ?? {};
  const gatewayUrl = (config.gatewayUrl as string) ?? 'http://localhost:18789';
  const gatewayToken = config.gatewayToken as string | undefined;
  const sessionKey = (config.sessionKey as string) ?? 'main';

  let server: Awaited<ReturnType<typeof createRemoteClawServer>> | null = null;

  api.registerService({
    name: 'remoteclaw',

    async start() {
      let createOpenClawTools: (opts: unknown) => AgentTool[];
      let createOpenClawCodingTools: (opts: unknown) => AgentTool[];

      try {
        // Dynamically import OpenClaw tool creators at runtime.
        // These modules only exist inside the OpenClaw gateway process.
        const openclawToolsPath = '../../src/agents/openclaw-tools.js';
        const piToolsPath = '../../src/agents/pi-tools.js';
        const [toolsMod, codingMod] = await Promise.all([
          import(openclawToolsPath),
          import(piToolsPath),
        ]);
        createOpenClawTools = toolsMod.createOpenClawTools;
        createOpenClawCodingTools = codingMod.createOpenClawCodingTools;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[remoteclaw] Failed to load OpenClaw tool modules: ${msg}`);
      }

      const toolsFn = () => [
        ...createOpenClawTools({ config: api.config }),
        ...createOpenClawCodingTools({ config: api.config }),
      ];

      const invoker = new ToolInvoker(gatewayUrl, gatewayToken, sessionKey);
      server = createRemoteClawServer({ tools: toolsFn, invoker });

      console.error('[remoteclaw] MCP server created, ready for transport connection');
    },

    async stop() {
      if (server) {
        await server.close();
        server = null;
      }
      console.error('[remoteclaw] MCP server stopped');
    },
  });
}
