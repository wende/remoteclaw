import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { agentToolsToMcpTools } from './tool-discovery.js';
import { mapInvokeResponse, mapToolError } from './result-mapper.js';
import type { ToolInvoker } from './tool-invoker.js';
import type { AgentTool } from './types.js';

export interface CreateRemoteClawServerOptions {
  tools: AgentTool[] | (() => AgentTool[]);
  invoker: ToolInvoker;
}

export function createRemoteClawServer(options: CreateRemoteClawServerOptions): Server {
  const { tools, invoker } = options;

  const resolveTools = typeof tools === 'function' ? tools : () => tools;

  const server = new Server(
    { name: 'remoteclaw', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const mcpTools = agentToolsToMcpTools(resolveTools());
    return { tools: mcpTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Verify tool exists
    const currentTools = resolveTools();
    const tool = currentTools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const response = await invoker.invoke(name, (args ?? {}) as Record<string, unknown>);
      // Cast: McpToolResult is structurally compatible with CallToolResult
      return mapInvokeResponse(response) as any;
    } catch (error) {
      return mapToolError(error) as any;
    }
  });

  return server;
}
