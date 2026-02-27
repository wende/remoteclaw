import type { AgentToolResult, McpToolResult, ToolInvokeResponse } from './types.js';

const MAX_TEXT_CHARS = 100_000;

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const truncated = text.slice(0, MAX_TEXT_CHARS);
  return `${truncated}\n\n[… truncated – ${text.length - MAX_TEXT_CHARS} chars omitted (${text.length} total)]`;
}

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

/** Apply truncation as a final safety net — call AFTER any post-processing. */
export function truncateResult(result: McpToolResult): McpToolResult {
  return {
    ...result,
    content: result.content.map((item) => {
      if (item.type === 'text') {
        return { ...item, text: truncateText(item.text) };
      }
      return item;
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
