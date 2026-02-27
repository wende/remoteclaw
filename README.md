# RemoteClaw

OpenClaw plugin that runs an MCP server, exposing **every** OpenClaw tool as an individual MCP tool. Instead of proxying entire conversations through a single `openclaw_chat` tool, RemoteClaw exposes `exec`, `read`, `write`, `browser`, `web_search`, `memory_search`, etc. as separate MCP tools — letting Claude Desktop/Claude.ai call them directly with zero model-inference overhead.

## Architecture

```
Claude Desktop / Claude.ai
    ↕ MCP Protocol (stdio or SSE)
RemoteClaw MCP Server (OpenClaw plugin)
    ↕ HTTP POST /tools/invoke
OpenClaw Gateway (localhost:18789)
    ↕ tool execution
exec, read, write, browser, web_search, ...
```

**Discovery** happens in-process via `createOpenClawTools()` + `createOpenClawCodingTools()` — the plugin imports these at runtime from the OpenClaw gateway process to enumerate all available tools with their JSON schemas.

**Execution** goes through `POST /tools/invoke` on the gateway — this gets the full policy pipeline, auth, and hooks for free.

## Project Structure

```
src/
├── index.ts              # Plugin entry point (register + service lifecycle)
├── types.ts              # Local type interfaces (AgentTool, McpTool, etc.)
├── tool-discovery.ts     # AgentTool[] → MCP Tool[] conversion
├── tool-invoker.ts       # HTTP client for POST /tools/invoke
├── result-mapper.ts      # OpenClaw result → MCP result mapping
├── mcp-server.ts         # MCP Server factory
└── __tests__/
    ├── result-mapper.test.ts
    ├── tool-invoker.test.ts
    └── mcp-server.integration.test.ts
```

## Development

```bash
npm install
npm test          # vitest watch mode
npm run test:run  # single run (31 tests)
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/index.js
```

## How It Works

### Tool Discovery (`tool-discovery.ts`)

Converts OpenClaw's `AgentTool[]` (with `name`, `description`, `parameters`) into MCP-compatible tool definitions with `inputSchema`.

### Tool Invocation (`tool-invoker.ts`)

HTTP client that sends `POST /tools/invoke` requests to the OpenClaw gateway:

```json
{
  "tool": "web_search",
  "args": { "query": "hello" },
  "sessionKey": "main"
}
```

Supports configurable gateway URL, auth token, session key, and timeout.

### Result Mapping (`result-mapper.ts`)

Maps between OpenClaw and MCP result formats:
- Text and image content pass through directly
- `details` field is stripped (MCP doesn't use it)
- `{ok: false}` responses become `{isError: true}` MCP results
- Exceptions are caught and mapped to error results

### MCP Server (`mcp-server.ts`)

Factory function that wires everything together:
- Registers `ListToolsRequestSchema` handler for tool enumeration
- Registers `CallToolRequestSchema` handler for tool execution
- Supports static tool arrays or dynamic functions (re-evaluated on each `tools/list`)

### Plugin Entry (`index.ts`)

Registers as an OpenClaw service with `start()`/`stop()` lifecycle:
- Dynamically imports tool creators from the OpenClaw gateway process
- Creates `ToolInvoker` and `MCP Server`
- Exports all modules for standalone use

## Configuration

Plugin config via `openclaw.plugin.json`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `transport` | `"stdio" \| "sse"` | `"sse"` | MCP transport |
| `port` | `number` | `3100` | SSE server port |
| `auth` | `boolean` | `false` | Enable auth |

Runtime config passed via `api.config`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `gatewayUrl` | `string` | `http://localhost:18789` | Gateway URL |
| `gatewayToken` | `string` | — | Bearer token |
| `sessionKey` | `string` | `main` | Session key |

## Testing

31 tests across 3 suites:

- **result-mapper** (10 tests) — pure data transformation, zero deps
- **tool-invoker** (10 tests) — HTTP proxy with mocked `fetch`
- **mcp-server integration** (11 tests) — full MCP Client↔Server via `InMemoryTransport`

Integration tests create a real MCP `Client` and `Server` connected in-process, verifying the entire pipeline from `client.callTool()` through HTTP invocation to result mapping.
