# Dynamic Tool Discovery

## The Problem

The static `tool-catalog.json` approach (see `catalog-generation.md`) only captures tools known at catalog-generation time — built-in tools from `createOpenClawTools()`. It **cannot** include plugin-registered tools (like `model_usage` or `minimax_web_search`) because those tools only exist at runtime after all plugins have loaded and called `api.registerTool()`.

This defeats the purpose of RemoteClaw: exposing ALL OpenClaw tools (core + plugin-registered) as individual MCP tools.

## Discovery Chain

RemoteClaw uses a 3-tier fallback chain:

```
1. invoker.listTools()              → HTTP GET {gateway}/tools (future-proofing)
2. discoverToolsDynamic()           → source tree import (dev machines)
3. loadToolCatalog()                → static catalog (16 core tools)
   + discoverPluginToolsFromRegistry() → globalThis registry (plugin tools)
```

On dev machines, tier 2 works and returns everything. On deployed machines without source, tiers 1+3 combine to give the full list.

## Tier 1: HTTP Gateway Query

`ToolInvoker.listTools()` does `GET {gatewayUrl}/tools`. The gateway doesn't have this endpoint yet, so it returns `[]` and falls through. Kept as a no-op for future use.

## Tier 2: Source Tree Dynamic Import

Dynamically imports `createOpenClawTools()` from the OpenClaw dev source at startup. This function internally calls `resolvePluginTools()`, which loads all plugins and collects their registered tools.

```
discoverToolsDynamic()
  → findOpenClawRoot() (5 strategies: config, env, argv, require.resolve, well-known paths)
  → import('~/projects/openclaw/src/agents/openclaw-tools.ts')
    → jiti handles .ts transpilation (gateway's loader)
    → createOpenClawTools({ config })
      → resolvePluginTools() → loadOpenClawPlugins() → all plugin tool factories
      → combines built-in + plugin tools
```

Works because RemoteClaw runs **inside** the gateway process. The gateway's jiti loader handles TypeScript imports transparently.

## Tier 3: Static Catalog + globalThis Registry

When source tree is unavailable (deployed machines), two sources combine:

### Static catalog (core tools)
`tool-catalog.json` provides the 16 core tools. Generated offline via `npm run refresh-catalog`.

### globalThis registry (plugin tools) — THE KEY DISCOVERY

The gateway stores its plugin registry on `globalThis` via a well-known Symbol:

```typescript
const REGISTRY_STATE = Symbol.for('openclaw.pluginRegistryState');
const registryState = (globalThis as any)[REGISTRY_STATE];
const registry = registryState?.registry;
// registry.tools = PluginToolRegistration[] with factory functions
```

Since RemoteClaw runs in the same process as the gateway, it can read this directly — no imports, no file scanning, no side effects. Each `PluginToolRegistration` has a `factory` function that returns actual tool objects when called with `{ config }`.

`discoverPluginToolsFromRegistry()` iterates `registry.tools`, calls each factory, extracts `{ name, description, parameters }`, and returns them. Combined with the static catalog, this gives the complete tool list.

## What DIDN'T Work: Dist Chunk Scanning

### The Attempt

The openclaw npm package bundles everything with tsdown into hashed chunks (`reply-D-ejYZny.js`, `gateway-cli-abc123.js`, etc.). `createOpenClawTools` IS present in one of these chunks. We tried:

1. `findOpenClawDist()` — locate the dist directory (argv, walk-up, fnm/nvm paths)
2. `importCreateOpenClawToolsFromDist()` — scan chunks for `createOpenClawTools` string, import them, probe exports by calling with `{ config: {} }` and checking if the result looks like a tool array

### The Crash

This caused **SIGUSR1 crash loops** on the remote machine. Bundled dist chunks have heavy top-level side effects:

- `gateway-cli-*.js` registers signal handlers (`SIGUSR1`, `SIGTERM`)
- `pi-embedded-*.js` sets up lifecycle management
- Importing these chunks inside the already-running gateway re-registers signal handlers, which triggers restart signals, which causes the gateway to restart, which re-imports, etc.

The crash was: gateway starts → loads RemoteClaw → dist scan imports `gateway-cli-*.js` → top-level code sends SIGUSR1 → gateway restarts → repeat forever.

### Lesson

**Never dynamically import bundled dist chunks** — they contain top-level side effects from the entire module graph. Even "just checking exports" executes the full chunk. The only safe way to get data from the running process is through shared memory (globalThis) or explicit APIs.

The dist-scanning code (`findOpenClawDist`, `importCreateOpenClawToolsFromDist`) is kept as dead code in `tool-discovery.ts` for reference but is NOT called anywhere.

## Verification

### Dev machine (source tree available)
```bash
curl -sk https://127.0.0.1:3100/health
# → {"ok":true,"tools":23,"sessions":0,"tls":true,"auth":true}
# 23 = dynamic discovery via createOpenClawTools
```

### Deployed machine (no source tree)
```
[remoteclaw] Dynamic discovery unavailable (...), using static catalog
[remoteclaw] Loaded 16 tools from static catalog
[remoteclaw] Added 7 plugin tools from registry
# Total: 23 tools (16 core + 7 plugin)
```

### MCP endpoint verification
Full OAuth PKCE flow → `tools/list` returns 29 tools (23 discovered + 6 native RemoteClaw tools). Both core tools and plugin tools (`model_usage`, `minimax_web_search`, etc.) are callable and return valid results.

## File Changes

| File | Change |
|------|--------|
| `src/tool-discovery.ts` | `findOpenClawRoot()`, `discoverToolsDynamic()`, `discoverPluginToolsFromRegistry()`, dead code: `findOpenClawDist()`, `importCreateOpenClawToolsFromDist()` |
| `src/tool-invoker.ts` | Added `listTools()` method (HTTP GET /tools) |
| `src/index.ts` | 3-tier discovery chain in `start()`, `/tools/list` gateway route, exports |
| `src/types.ts` | Extended `PluginApi` with `registerHttpRoute`, `runtime` |
| `src/__tests__/tool-discovery.test.ts` | Tests for `findOpenClawRoot`, `findOpenClawDist`, `agentToolsToMcpTools`, `discoverPluginToolsFromRegistry` |
| `src/__tests__/tool-invoker.test.ts` | Tests for `listTools()` |
