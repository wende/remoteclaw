# Transport & Deployment

## MCP Transport

RemoteClaw uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` (the newer replacement for the deprecated `SSEServerTransport`).

- Endpoint: `http://127.0.0.1:<port>/mcp` (default port 3100)
- Health check: `http://127.0.0.1:<port>/health`
- Protocol: MCP Streamable HTTP (supports both SSE streaming and direct HTTP responses)
- Session mode: stateful (`sessionIdGenerator: () => randomUUID()`)

## Multi-Session Support

Each incoming MCP client gets its own Server + Transport pair. Sessions are tracked by `mcp-session-id` header. The health endpoint reports active session count.

Lifecycle: new POST to `/mcp` without a session header → creates new session → returns `mcp-session-id`. Subsequent requests with that header route to the existing session. Transport `onclose` cleans up.

## Deployment Steps

1. Ensure `plugins.load.paths` in `~/.openclaw/openclaw.json` points to the remoteclaw directory
2. Add `remoteclaw` entry under `plugins.entries` with gateway config
3. Restart the gateway: `openclaw gateway install` (or `launchctl` commands)
4. Verify: `curl -sk https://127.0.0.1:3100/health` should return `{"ok":true,"tools":19,...}` (dynamic discovery) or `{"ok":true,"tools":16,...}` (static catalog fallback)

## Gateway Restart

The gateway runs as a macOS LaunchAgent:
```bash
# Stop
launchctl bootout gui/501 ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Start
launchctl bootstrap gui/501 ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Or use the CLI
openclaw gateway install   # installs and starts
```

Allow ~3 seconds after restart for the plugin service to start and begin listening.

## End-to-End Data Flow

```
MCP Client (Claude Desktop / SDK client)
    ↕ Streamable HTTP (POST /mcp, TLS)
RemoteClaw MCP Server (port 3100)
    ├─ Native tools (openclaw_chat, etc.) → handled locally
    └─ Proxy tools (web_search, echo, etc.)
         ↕ HTTP POST /tools/invoke
    OpenClaw Gateway (port 18789)
         ↕ tool.execute()
    Tool Implementation (web_search, browser, plugin tools, etc.)
```

## Gateway Tool Filtering

Not all tools in the catalog may be available via `/tools/invoke`. The gateway applies a policy pipeline:

1. Profile-level tool policy
2. Agent-level tool policy
3. Group-level tool policy
4. Subagent tool policy
5. **Gateway HTTP deny list** (`DEFAULT_GATEWAY_HTTP_TOOL_DENY`) — some tools are blocked by default for HTTP access

If a tool call returns `{"ok":false,"error":{"type":"not_found",...}}`, the tool may be on the deny list. Check `gateway.tools.allow` in config to explicitly allow it.
