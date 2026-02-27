# Dynamic Tool Discovery

## The Problem

The static `tool-catalog.json` approach (see `catalog-generation.md`) only captures tools known at catalog-generation time — built-in tools from `createOpenClawTools()`. It **cannot** include plugin-registered tools (like an `echo` tool from a test plugin) because those tools only exist at runtime after all plugins have loaded and called `api.registerTool()`.

This defeats the purpose of RemoteClaw: exposing ALL OpenClaw tools (core + coding + plugin-registered) as individual MCP tools.

## Solution: Runtime Dynamic Import

RemoteClaw now dynamically imports `createOpenClawTools()` from the OpenClaw dev source at startup. This function internally calls `resolvePluginTools()`, which loads all plugins and collects their registered tools — giving us the complete tool list including plugin-registered ones.

```
Gateway starts → loads plugins (including RemoteClaw)
  → RemoteClaw.start() calls discoverToolsDynamic()
    → finds OpenClaw source root (~/projects/openclaw)
    → dynamic import of src/agents/openclaw-tools.ts
    → createOpenClawTools({ config }) returns ALL tools
    → 19 tools (16 built-in + echo + memory_search + memory_get)
```

Falls back to static `tool-catalog.json` if dynamic discovery fails.

## Finding the OpenClaw Source Root

The biggest challenge: the gateway runs from the globally installed package (`~/.local/share/fnm/.../node_modules/openclaw/dist/`), which only has bundled dist files. `createOpenClawTools` is NOT exported from any public entry point.

`findOpenClawRoot()` tries 5 strategies in order:

1. **Plugin config**: `openclawRoot` in `plugins.entries.remoteclaw.config`
2. **Env var**: `OPENCLAW_ROOT`
3. **process.argv detection**: Looks for `/src/` in argv paths (works when gateway runs from source via `tsx`)
4. **require.resolve**: Tries `require.resolve('openclaw/package.json')` and checks if that location has source files
5. **Well-known dev paths**: `~/projects/openclaw`, `~/src/openclaw`, `~/dev/openclaw`

Each candidate is validated by checking for the marker file `src/agents/openclaw-tools.ts`.

### What Failed Before Strategy 5

The first build only had strategies 1-4. On this machine:
- Strategy 3 failed: argv contains `.../openclaw/dist/subsystem-DkqfG4LL.js` (no `/src/` segment)
- Strategy 4 failed: the installed package root has `dist/` not `src/`

Adding strategy 5 (well-known dev paths) fixed it.

## The Dynamic Import Chain

```
discoverToolsDynamic()
  → import('~/projects/openclaw/src/agents/openclaw-tools.ts')
    → jiti handles .ts → .js transpilation (gateway's loader)
    → createOpenClawTools({ config })
      → resolvePluginTools()  ← THIS is what discovers plugin tools
        → loadOpenClawPlugins()
        → creates fresh PluginRegistry
        → each plugin's register() adds tool factories
        → resolves all tool factories into AnyAgentTool[]
      → combines built-in tools + plugin tools
      → returns complete array
```

The key insight: this works because RemoteClaw runs **inside** the gateway process. The gateway's jiti loader handles TypeScript imports transparently. We're not spawning a separate process or using a different module loader.

## Config Loading

`createOpenClawTools()` requires the OpenClaw config object. Two paths:

1. **Preferred**: Use `api.runtime.config.loadConfig()` if available in the plugin context — this gives the live runtime config
2. **Fallback**: Dynamically import `src/config/config.ts` from the source root and call `loadConfig()`

Currently using fallback (path 2) because `api.runtime` isn't consistently available. Works fine — the config is the same either way since both read `~/.openclaw/openclaw.json`.

## Gateway HTTP Route: /tools/list

For debugging, RemoteClaw registers a `/tools/list` HTTP route on the gateway (port 18789):

```bash
curl http://127.0.0.1:18789/tools/list | jq '.[].name'
```

Returns the raw `AgentTool[]` array (before MCP conversion). Useful for checking what was discovered without needing an MCP client.

Registered via `api.registerHttpRoute()` — dispatched through the gateway's plugin HTTP handler with exact path matching.

## Issues Encountered

### "Cannot find OpenClaw source root"
**Cause**: First build only had strategies 1-4, none found the source on this machine.
**Fix**: Added strategy 5 (well-known dev paths like `~/projects/openclaw`).

### Gateway Restart Dance
After rebuilding (`npm run build`), the gateway must be restarted to pick up changes. The LaunchAgent sometimes takes multiple attempts:
```bash
openclaw gateway stop
# wait a few seconds
openclaw gateway install
```
The gateway log (`/tmp/openclaw/openclaw-*.log`) and the remoteclaw health endpoint (`curl -sk https://127.0.0.1:3100/health`) confirm startup. Allow ~5 seconds for plugin services to initialize.

### Tests vs Reality
`discoverToolsDynamic()` can't be unit-tested in vitest because it dynamically imports OpenClaw internals that depend on the full module graph (loggers, typebox schemas, plugin loaders, etc.). The import chain fails with errors like `createSubsystemLogger is not a function`. Only testable inside the actual gateway process.

`findOpenClawRoot()` is fully unit-testable. But tests must account for the dev machine having `~/projects/openclaw` — strategy 5 will find it, so tests can't assume `findOpenClawRoot({})` returns `null`.

### Static Catalog Still Needed
The static catalog is the fallback for when dynamic discovery fails (e.g., deployed without dev source). Keep `npm run refresh-catalog` working.

## Verification

```bash
# Health check (19 = dynamically discovered tools)
curl -sk https://127.0.0.1:3100/health
# → {"ok":true,"tools":19,"sessions":0,"tls":true}

# Tool list via gateway (includes plugin tools like 'echo')
curl http://127.0.0.1:18789/tools/list | jq '.[].name'

# Full MCP tools (19 discovered + 6 native = 25)
# Use any MCP client or the Python test script in the session transcript
```

## File Changes

| File | Change |
|------|--------|
| `src/tool-discovery.ts` | Added `findOpenClawRoot()`, `discoverToolsDynamic()` |
| `src/index.ts` | Wired dynamic discovery in `start()`, added `/tools/list` route |
| `src/types.ts` | Extended `PluginApi` with `registerHttpRoute`, `runtime` |
| `src/__tests__/tool-discovery.test.ts` | Tests for `findOpenClawRoot` and `agentToolsToMcpTools` |
