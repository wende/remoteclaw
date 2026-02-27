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
  registerHttpRoute?(params: {
    path: string;
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>;
  }): void;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  runtime?: {
    config: {
      loadConfig: () => Record<string, unknown>;
    };
  };
}

export interface PluginService {
  id: string;
  start(ctx?: unknown): void | Promise<void>;
  stop?(ctx?: unknown): void | Promise<void>;
}
