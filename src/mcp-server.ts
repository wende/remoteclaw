import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { agentToolsToMcpTools } from './tool-discovery.js';
import { mapInvokeResponse, mapToolError, truncateResult } from './result-mapper.js';
import type { ToolInvoker } from './tool-invoker.js';
import type { AgentTool, McpTool, McpToolResult } from './types.js';
import type { NativeToolHandler } from './native-tools.js';

export interface CreateRemoteClawServerOptions {
  tools: AgentTool[] | (() => AgentTool[]);
  invoker: ToolInvoker;
  nativeHandler?: NativeToolHandler;
  extraTools?: McpTool[];
}

// ---------------------------------------------------------------------------
// Gateway tool enhancement: add `path` param and strip uiHints
// ---------------------------------------------------------------------------

/**
 * Patch the gateway tool definition to add a `path` parameter for config.schema.
 */
function patchGatewayTool(allTools: McpTool[]): McpTool[] {
  return allTools.map((tool) => {
    if (tool.name !== 'gateway') return tool;
    return {
      ...tool,
      description:
        tool.description +
        '\n\nRemoteClaw extension: config.schema accepts an optional `path` param ' +
        '(dot-separated, e.g. "gateway", "agents.defaults") to return only that section. ' +
        'uiHints are always stripped.',
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          path: {
            type: 'string',
            description:
              'Dot-separated path into the config schema (e.g. "gateway", "agents.defaults.model"). ' +
              'Omit to return top-level property list.',
          },
        },
      },
    };
  });
}

/**
 * Drill into a JSON schema by dot-separated property path.
 */
function resolveSchemaPath(schema: Record<string, unknown>, path: string): Record<string, unknown> | null {
  const parts = path.split('.');
  let current: Record<string, unknown> = schema;

  for (const part of parts) {
    const props = current.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props || !(part in props)) return null;
    current = props[part];
  }

  return current;
}

/**
 * Post-process gateway config.schema responses:
 * - Always strip uiHints
 * - If path was given, drill into the schema
 * - If no path, return top-level property names as a summary
 */
function postProcessConfigSchema(result: McpToolResult, path?: string): McpToolResult {
  const textItem = result.content.find((c) => c.type === 'text');
  if (!textItem || textItem.type !== 'text') return result;

  try {
    const outer = JSON.parse(textItem.text);
    if (!outer?.ok || !outer?.result?.schema) return result;

    const schema = outer.result.schema as Record<string, unknown>;

    if (path) {
      const resolved = resolveSchemaPath(schema, path);
      if (!resolved) {
        return {
          content: [{ type: 'text', text: `Schema path "${path}" not found. Top-level properties: ${Object.keys((schema.properties ?? {}) as Record<string, unknown>).join(', ')}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(resolved, null, 2) }],
      };
    }

    // No path: return a compact summary of top-level properties
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const summary: Record<string, string> = {};
    for (const [key, val] of Object.entries(props)) {
      const type = val.type as string ?? 'object';
      const subProps = val.properties as Record<string, unknown> | undefined;
      summary[key] = subProps
        ? `${type} { ${Object.keys(subProps).join(', ')} }`
        : type;
    }
    return {
      content: [{
        type: 'text',
        text: `Config schema (v${outer.result.version ?? '?'}). Use path param to drill in.\n\n` +
          JSON.stringify(summary, null, 2),
      }],
    };
  } catch {
    return result;
  }
}

// ---------------------------------------------------------------------------

export function createRemoteClawServer(options: CreateRemoteClawServerOptions): Server {
  const { tools, invoker, nativeHandler, extraTools } = options;

  const resolveTools = typeof tools === 'function' ? tools : () => tools;

  const server = new Server(
    { name: 'remoteclaw', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const catalogMcpTools = agentToolsToMcpTools(resolveTools());
    const allTools: McpTool[] = patchGatewayTool([...catalogMcpTools, ...(extraTools ?? [])]);
    return { tools: allTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    // Native tools get handled directly (chat, status, async tasks)
    if (nativeHandler?.handles(name)) {
      return nativeHandler.handle(name, safeArgs) as any;
    }

    // Gateway config.schema: extract our custom `path` param before proxying
    let schemaPath: string | undefined;
    if (name === 'gateway' && safeArgs.action === 'config.schema') {
      schemaPath = typeof safeArgs.path === 'string' ? safeArgs.path : undefined;
      delete safeArgs.path; // don't send to gateway — it doesn't know about it
    }

    // All other tools get proxied through the gateway's /tools/invoke.
    // No local validation — the gateway is the source of truth for tool availability.
    // This allows plugin-registered tools to be called even if they're not in the static catalog.
    try {
      const response = await invoker.invoke(name, safeArgs);
      let result = mapInvokeResponse(response) as any;

      // Post-process config.schema
      if (name === 'gateway' && safeArgs.action === 'config.schema') {
        result = postProcessConfigSchema(result, schemaPath);
      }

      return truncateResult(result);
    } catch (error) {
      return mapToolError(error) as any;
    }
  });

  return server;
}
