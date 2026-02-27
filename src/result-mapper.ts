import type { AgentToolResult, McpToolResult, ToolInvokeResponse } from './types.js';

export function mapToolResult(result: AgentToolResult): McpToolResult {
  return {
    content: result.content.map((item) => {
      if (item.type === 'image') {
        return { type: 'image' as const, data: item.data, mimeType: item.mimeType };
      }
      return { type: 'text' as const, text: item.text };
    }),
  };
}

export function mapToolError(error: unknown): McpToolResult {
  const message = error instanceof Error ? error.message : 'Tool execution failed';
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function mapInvokeResponse(response: ToolInvokeResponse): McpToolResult {
  if (!response.ok) {
    return {
      content: [{ type: 'text', text: response.error ?? 'Tool invocation failed' }],
      isError: true,
    };
  }
  if (response.result) {
    return mapToolResult(response.result);
  }
  return { content: [] };
}
