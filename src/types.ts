// Local type interfaces mirroring OpenClaw types.
// Avoids importing from OpenClaw source during development/testing.

export interface AgentToolParameter {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: AgentToolParameter;
}

export type AgentToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface AgentToolResult {
  content: AgentToolResultContent[];
  details?: unknown;
}

export interface ToolInvokeResponse {
  ok: boolean;
  result?: AgentToolResult;
  error?: string;
}

export type McpToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpToolResultContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

// Plugin API interface (subset of OpenClawPluginApi)
export interface PluginApi {
  registerService(service: PluginService): void;
  config: Record<string, unknown>;
}

export interface PluginService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
