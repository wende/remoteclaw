# Gateway Tool Deny List & config.get Fix

## The Problem

Calling `gateway` with `action: "config.get"` through RemoteClaw returned HTTP 404. Other tools like `nodes` worked fine.

## Root Cause

The gateway has a hardcoded deny list in `dangerous-tools-*.js`:

```js
DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  "sessions_spawn",
  "sessions_send",
  "cron",
  "gateway",
  "whatsapp_login"
]
```

When a tool on this list is called via `POST /tools/invoke`, the gateway returns:
```json
{"ok": false, "error": {"type": "not_found", "message": "Tool not available: gateway"}}
```

Which our `mapInvokeResponse()` mapped to an MCP error — but the MCP client saw it as a 404.

## The Fix

The `GatewayToolsConfig` type (in `plugin-sdk/config/types.gateway.d.ts`) exposes `allow` and `deny` arrays that override the default deny list. Adding `gateway.tools.allow` in `~/.openclaw/openclaw.json`:

```json
{
  "gateway": {
    "tools": {
      "allow": ["gateway", "sessions_spawn", "sessions_send", "cron"]
    }
  }
}
```

After restarting the gateway (`kill -USR1 <pid>`), `config.get` works.

## Debugging Path

1. Confirmed MCP server on port 3100 was healthy (`/health` returned OK)
2. Confirmed gateway on port 18789 was running (served SPA HTML on `/`)
3. Tested `/tools/invoke` directly with curl — got "Unauthorized" (missing token)
4. Added Bearer token from `gateway.auth.token` in config — got the "Tool not available" error
5. Searched gateway source for deny/block logic → found `DEFAULT_GATEWAY_HTTP_TOOL_DENY`
6. Found the override mechanism in the `GatewayToolsConfig` type definition

## Gotcha: Gateway Restart Invalidates MCP Sessions

After `kill -USR1`, the gateway restarts but all MCP sessions are lost. The MCP client continues sending the old `mcp-session-id` header, and the new server transport rejects it because it requires `initialize` as the first request per session.

This led to the stale session recovery work — see `stale-session-recovery.md`.
