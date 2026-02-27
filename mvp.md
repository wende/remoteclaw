# RemoteClaw MVP — MCP Server as an OpenClaw Extension

## Goal

Build an OpenClaw plugin that runs an MCP server, exposing **every OpenClaw tool** (core + plugin) as individual MCP tools. Claude Desktop / Claude.ai can then call `exec`, `read`, `write`, `browser`, `web_search`, `memory_search`, etc. directly — no model inference round-trip through OpenClaw.

---

## Key Discovery: `POST /tools/invoke` Already Exists

The OpenClaw gateway already exposes a direct tool invocation HTTP endpoint at `src/gateway/tools-invoke-http.ts`:

```
POST http://localhost:18789/tools/invoke
Authorization: Bearer <gateway-token>
Content-Type: application/json

{
  "tool": "web_search",
  "action": "search",
  "args": { "query": "hello" },
  "sessionKey": "main"
}
```

Response:
```json
{
  "ok": true,
  "result": {
    "content": [{ "type": "text", "text": "..." }],
    "details": { ... }
  }
}
```

This endpoint:
1. Calls `createOpenClawTools()` — enumerates ALL tools (core + plugin)
2. Applies the full tool policy pipeline (allow/deny, profiles)
3. Finds the tool by name
4. Calls `tool.execute(toolCallId, args)` directly — no model involved
5. Returns the raw result

### Default HTTP Deny List

Only 4 tools denied by default over HTTP (configurable via `gateway.tools.allow`):
- `sessions_spawn` — remote code execution risk
- `sessions_send` — cross-session message injection
- `gateway` — gateway reconfiguration
- `whatsapp_login` — requires interactive QR scan

Source: `src/security/dangerous-tools.ts`

---

## Architecture

```
Claude Desktop / Claude.ai
    ↕ (MCP Protocol — stdio or SSE)
RemoteClaw MCP Server (OpenClaw plugin, in-process)
    ↕ (in-process import OR HTTP localhost)
OpenClaw Gateway
    ↕ (tool execution)
exec, read, write, browser, web_search, memory_search, ...
```

---

## Three Execution Strategies

### Strategy 1: HTTP Proxy (Simplest)

Proxy every MCP tool call to `POST /tools/invoke`:

```typescript
async function invokeTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${gatewayUrl}/tools/invoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ tool: name, args }),
  });
  return await res.json();
}
```

Pros: Full policy pipeline, auth, hooks for free. Clean separation.
Cons: HTTP overhead per call. No tool list endpoint (need in-process for discovery).

### Strategy 2: In-Process Import (Most Powerful)

Import internal modules directly since plugins run in the same Node.js process:

```typescript
import { createOpenClawTools } from '../../agents/openclaw-tools.js';
import { createOpenClawCodingTools } from '../../agents/pi-tools.js';

const tools = createOpenClawTools({ config: api.config });
// tools[i].name, .description, .parameters (JSON Schema), .execute()
```

Pros: Zero-latency, full access to tool schemas and execute functions.
Cons: Tight coupling to internals, may break between versions.

### Strategy 3: Hybrid (Recommended for MVP)

1. **Discovery:** Import `createOpenClawTools()` + `createOpenClawCodingTools()` to enumerate tools and extract JSON schemas
2. **Execution:** Call `POST /tools/invoke` for actual execution (gets full policy pipeline for free)
3. **Fallback:** Direct `tool.execute()` for tools that don't work well over HTTP

---

## Tool Interface (Internal)

From `src/agents/tools/common.ts`:

```typescript
type AnyAgentTool = {
  name: string;
  description: string;
  parameters: JsonSchema;         // JSON Schema for input validation
  ownerOnly?: boolean;
  execute: (
    toolCallId: string,           // unique ID, e.g. "mcp-1234567890"
    params: unknown,              // the tool arguments
    signal?: AbortSignal,         // optional cancellation
    onUpdate?: (partial) => void, // optional streaming updates
  ) => Promise<AgentToolResult>;
};

type AgentToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  details?: unknown;
};
```

This maps almost 1:1 to MCP's tool result format.

---

## Available Tools (Full List)

### Core Non-Coding Tools (`createOpenClawTools`)

Source: `src/agents/openclaw-tools.ts`

| Tool | Creator | Description |
|------|---------|-------------|
| `browser` | `createBrowserTool()` | UI automation & screenshots |
| `canvas` | `createCanvasTool()` | Node canvas control |
| `nodes` | `createNodesTool()` | Paired device discovery & control |
| `cron` | `createCronTool()` | Gateway cron jobs |
| `message` | `createMessageTool()` | Cross-channel messaging |
| `tts` | `createTtsTool()` | Text-to-speech |
| `gateway` | `createGatewayTool()` | Gateway restart/config |
| `agents_list` | `createAgentsListTool()` | List allowed sub-agents |
| `sessions_list` | `createSessionsListTool()` | List sessions |
| `sessions_history` | `createSessionsHistoryTool()` | Session history |
| `sessions_send` | `createSessionsSendTool()` | Cross-session messaging |
| `sessions_spawn` | `createSessionsSpawnTool()` | Spawn sub-agents |
| `subagents` | `createSubagentsTool()` | Sub-agent management |
| `session_status` | `createSessionStatusTool()` | Session status |
| `web_search` | `createWebSearchTool()` | Web search |
| `web_fetch` | `createWebFetchTool()` | Fetch web pages |
| `image` | `createImageTool()` | Image analysis |
| + plugin tools | `resolvePluginTools()` | Any plugin-registered tools |

### Core Coding Tools (`createOpenClawCodingTools`)

Source: `src/agents/pi-tools.ts`

| Tool | Source | Description |
|------|--------|-------------|
| `exec` | `createExecTool()` | Shell command execution |
| `bash` | alias | Shell (alias for exec) |
| `process` | `createProcessTool()` | Process management |
| `read` | `createReadTool()` / `createOpenClawReadTool()` | Read files |
| `write` | `createWriteTool()` | Write files |
| `edit` | `createEditTool()` | Edit files |
| `apply_patch` | `createApplyPatchTool()` | Apply patches |

---

## Key Source Files

| Purpose | Path | Function/Export |
|---------|------|-----------------|
| All non-coding tools | `src/agents/openclaw-tools.ts` | `createOpenClawTools(options)` |
| All coding tools | `src/agents/pi-tools.ts` | `createOpenClawCodingTools(options)` |
| HTTP tool invocation | `src/gateway/tools-invoke-http.ts` | `handleToolsInvokeHttpRequest()` |
| Tool type definition | `src/agents/tools/common.ts` | `AnyAgentTool` |
| Plugin API type | `src/plugins/types.ts` | `OpenClawPluginApi` |
| Plugin registry | `src/plugins/registry.ts` | `createPluginRegistry()` |
| Plugin tool resolver | `src/plugins/tools.ts` | `resolvePluginTools()` |
| Tool policy pipeline | `src/agents/tool-policy-pipeline.ts` | `applyToolPolicyPipeline()` |
| Default deny list | `src/security/dangerous-tools.ts` | `DEFAULT_GATEWAY_HTTP_TOOL_DENY` |
| Hook runner (global) | `src/plugins/hook-runner-global.ts` | `getGlobalHookRunner()` |

---

## Plugin Manifest

```json
{
  "id": "remoteclaw",
  "name": "RemoteClaw",
  "description": "MCP server exposing OpenClaw tools to Claude Desktop/Claude.ai",
  "configSchema": {
    "type": "object",
    "properties": {
      "transport": {
        "type": "string",
        "enum": ["stdio", "sse"],
        "default": "sse"
      },
      "port": {
        "type": "number",
        "default": 3100
      },
      "auth": {
        "type": "boolean",
        "default": false
      }
    },
    "additionalProperties": false
  }
}
```

---

## MCP ↔ OpenClaw Result Mapping

OpenClaw tool results map almost directly to MCP:

```typescript
// OpenClaw AgentToolResult
{
  content: [
    { type: 'text', text: '...' },
    { type: 'image', data: 'base64...', mimeType: 'image/png' }
  ],
  details: { ... }
}

// MCP CallToolResult
{
  content: [
    { type: 'text', text: '...' },
    { type: 'image', data: 'base64...', mimeType: 'image/png' }
  ],
  isError: false
}
```

The only difference is MCP uses `isError` instead of throwing exceptions. Wrap `execute()` in try/catch.

---

## MVP Implementation Plan

### Phase 1: Plugin Shell

- [ ] `openclaw.plugin.json` manifest
- [ ] `package.json` with `openclaw.extensions` entry
- [ ] `index.ts` — plugin entry point, registers HTTP handler or background service
- [ ] MCP server instance using `@modelcontextprotocol/sdk`

### Phase 2: Tool Discovery & Registration

- [ ] Import `createOpenClawTools()` to get non-coding tools
- [ ] Import `createOpenClawCodingTools()` to get coding tools (exec/read/write/edit)
- [ ] Extract `name`, `description`, `parameters` from each tool
- [ ] Register each as an MCP tool via `server.setRequestHandler(ListToolsRequestSchema, ...)`

### Phase 3: Tool Execution Bridge

- [ ] On MCP `CallToolRequestSchema`, find matching OpenClaw tool
- [ ] Call `POST /tools/invoke` with tool name and args
- [ ] Map OpenClaw result to MCP result format
- [ ] Handle errors (catch exceptions, set `isError: true`)

### Phase 4: Transport

- [ ] SSE transport via `api.registerHttpHandler()` on gateway HTTP
- [ ] OR background service with standalone HTTP server on separate port
- [ ] stdio transport for local Claude Desktop (optional)

### Phase 5: Polish

- [ ] Dynamic tool list refresh (re-enumerate on each `tools/list` request)
- [ ] Session key configuration (default to main, allow override)
- [ ] Logging and error sanitization
- [ ] Config schema for port, transport, auth settings

---

## Difficulty Assessment

| Component | Difficulty | Estimate |
|-----------|-----------|----------|
| Plugin shell + manifest | Easy (1/10) | 1 hour |
| MCP server setup | Easy (2/10) | 2 hours |
| Tool discovery (in-process) | Easy (2/10) | 2 hours |
| Tool execution (HTTP proxy) | Easy (2/10) | 2 hours |
| Result mapping | Easy (2/10) | 1 hour |
| Transport (SSE on gateway) | Medium (4/10) | 4 hours |
| Session management | Medium (3/10) | 2 hours |
| Testing | Medium (3/10) | 4 hours |
| **Total** | **Easy-Medium** | **~2-3 days** |

---

## Open Questions

1. **Transport choice:** Register MCP SSE on gateway HTTP (shares port 18789) or run on separate port?
2. **Coding tools:** Include `exec`/`read`/`write`/`edit` from `pi-tools.ts`, or only non-coding tools from `openclaw-tools.ts`?
3. **Tool policy:** Respect the full policy pipeline (via HTTP proxy) or bypass it (via direct execute)?
4. **Auth:** Reuse gateway token auth, or add MCP OAuth on top?
5. **Plugin tools:** How to handle tools registered by other plugins that may load after us?
