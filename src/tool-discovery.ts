import type { AgentTool, McpTool } from './types.js';

export function agentToolsToMcpTools(tools: AgentTool[]): McpTool[] {
  return tools.map((tool) => {
    const { type: _type, ...rest } = tool.parameters;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        ...rest,
        type: 'object' as const,
      },
    };
  });
}
