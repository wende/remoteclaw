# config.schema Enhancement

## The Problem

Calling `gateway` with `action: "config.schema"` returned **743,488 characters** — far too large for any LLM context window.

Breakdown of the raw response:
- Schema structure: ~136K chars
- `uiHints` (UI display metadata, useless for LLMs): ~216K chars
- Double-encoding overhead (JSON inside JSON): the rest

This is what agents in the OpenClaw agentic cycle receive too — every `config.schema` call dumps the entire thing with no filtering option. The gateway's `config.schema` action takes no parameters for partial retrieval.

## The Fix

Added client-side post-processing in RemoteClaw's MCP layer (`src/mcp-server.ts`) with three components:

### 1. `patchGatewayTool()` — Inject `path` parameter

Patches the `gateway` tool definition in `ListTools` to add a `path` string parameter and updates the description. The gateway itself doesn't know about this parameter — it's a RemoteClaw extension.

### 2. `postProcessConfigSchema()` — Filter and compact

Intercepts the raw gateway response for `config.schema` and:

**With `path` param** (e.g. `path=gateway`):
- Parses the raw JSON response
- Navigates into `result.schema.properties` by dot-separated path
- Returns just that section's schema (~2-5K chars instead of 743K)

**Without `path` param**:
- Returns a compact summary of all top-level config sections
- Format: `{ "sectionName": "type { prop1, prop2, ... }" }`
- ~1.5K chars total

**Path not found**:
- Returns error with list of valid top-level property names

### 3. `resolveSchemaPath()` — Dot-separated path navigation

Walks `schema.properties.a.properties.b.properties.c...` for a path like `"a.b.c"`. Returns `null` if any segment doesn't exist.

## The Truncation Bug

Initial implementation didn't work because `mapToolResult()` in `result-mapper.ts` applied `truncateText()` (100K char limit) **before** `postProcessConfigSchema()` could parse the response. The truncated JSON was invalid, `JSON.parse()` threw, the catch block silently returned the truncated raw response.

**Fix**: Extracted truncation into a separate `truncateResult()` function, called AFTER post-processing in the `CallToolRequestSchema` handler:

```typescript
// In mcp-server.ts CallToolRequestSchema handler:
let result = mapInvokeResponse(response);  // no truncation here

if (name === 'gateway' && safeArgs.action === 'config.schema') {
  result = postProcessConfigSchema(result, schemaPath);
}

return truncateResult(result);  // truncation as final safety net
```

## Request Flow

```
Client calls: gateway(action: "config.schema", path: "gateway")
  ↓
CallToolRequestSchema handler:
  1. Extract `path` from args, delete it (gateway doesn't know about it)
  2. Proxy to gateway /tools/invoke (without path)
  3. Gateway returns 743K raw response
  4. mapInvokeResponse() converts to McpToolResult (NO truncation)
  5. postProcessConfigSchema() parses JSON, drills to "gateway" section
  6. truncateResult() as final safety net
  7. Client receives ~3K of relevant schema
```

## Example Output

**No path** (~1.5K):
```
Config schema (v0.46.0). Use path param to drill in.

{
  "gateway": "object { port, mode, bind, auth, ... }",
  "agents": "object { defaults, profiles }",
  "plugins": "object { load, entries }",
  ...
}
```

**With `path=gateway`** (~3K):
```json
{
  "type": "object",
  "properties": {
    "port": { "type": "integer", "default": 18789 },
    "mode": { "type": "string", "enum": ["local", "remote"] },
    ...
  }
}
```

## File Changes

| File | Change |
|------|--------|
| `src/mcp-server.ts` | Added `patchGatewayTool()`, `resolveSchemaPath()`, `postProcessConfigSchema()`, intercepted `config.schema` in call handler |
| `src/result-mapper.ts` | Removed truncation from `mapToolResult()`, added separate `truncateResult()` export |
