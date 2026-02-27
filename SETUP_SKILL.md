# RemoteClaw Setup Skill

You are setting up the **RemoteClaw** OpenClaw plugin from scratch. RemoteClaw exposes every OpenClaw tool (built-in + plugin-registered) as individual MCP tools, letting MCP clients call `web_search`, `browser`, `sessions_send`, etc. directly — bypassing the single-chat-proxy pattern.

## Architecture Overview

```
MCP Client (Claude Desktop / Claude Code / Claude.ai)
    ↕ Streamable HTTP (POST /mcp, optional TLS)
RemoteClaw MCP Server (port 3100, runs inside the gateway process)
    ├─ Native tools (openclaw_chat, openclaw_status, async tasks) → handled locally
    └─ Proxy tools (web_search, browser, echo, etc.)
         ↕ HTTP POST /tools/invoke
    OpenClaw Gateway (port 18789)
         ↕ tool.execute()
    Tool Implementation (built-in + plugin-registered tools)
```

RemoteClaw is an OpenClaw **plugin** — it runs inside the gateway process, not as a standalone server. The gateway manages its lifecycle (start/stop).

---

## Step 1: Check Prerequisites

Verify the environment before doing anything else.

### 1a. Node.js >= 20

```bash
node --version
# Must be >= v20.0.0
```

If missing or too old, install via fnm, nvm, or the Node.js website.

### 1b. OpenClaw installed and running

```bash
which openclaw
openclaw --version
```

Check the gateway is running:

```bash
curl -s http://127.0.0.1:18789/v1/models 2>/dev/null | head -c 200
```

If the gateway isn't running:

```bash
openclaw gateway install
# Wait ~5 seconds
curl -s http://127.0.0.1:18789/v1/models | head -c 200
```

### 1c. Locate the OpenClaw config

The config file is at `~/.openclaw/openclaw.json`. Read it to understand existing settings:

```bash
cat ~/.openclaw/openclaw.json
```

Note the `gateway.auth.token` value — you'll need it for the plugin config. If `gateway.auth.mode` is `"token"`, the token is in `gateway.auth.token`.

### 1d. Locate the RemoteClaw source

The remoteclaw source must be accessible on the local filesystem. It lives at a path like `/path/to/openclaw-mcp/remoteclaw/`. Confirm it has:
- `package.json` (with `"name": "remoteclaw"`)
- `openclaw.plugin.json` (with `"id": "remoteclaw"`)
- `src/index.ts`

---

## Step 2: Install Dependencies and Build

```bash
cd /path/to/remoteclaw
npm install
npm run build
```

Verify the build produced output:

```bash
ls dist/index.js
```

### Run tests (optional but recommended)

```bash
npm run test:run
```

All tests should pass. If they don't, fix issues before proceeding.

---

## Step 3: Set Up TLS (Optional — Required for Claude.ai)

If the MCP client requires HTTPS (Claude.ai does), generate locally-trusted TLS certs.

### 3a. Install mkcert

```bash
# macOS
brew install mkcert

# Linux — see https://github.com/FiloSottile/mkcert#installation
```

### 3b. Install the local CA (once per machine)

```bash
mkcert -install
```

### 3c. Generate certificates

```bash
cd /path/to/remoteclaw
mkdir -p certs
cd certs
mkcert localhost 127.0.0.1 ::1
cd ..
```

This creates `certs/localhost+2.pem` and `certs/localhost+2-key.pem`. RemoteClaw auto-detects these on startup. No config needed.

### 3d. For Node.js MCP clients

If a Node.js client gets `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, set:

```bash
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

**Skip this step entirely if you only need HTTP (local Claude Code/Desktop).**

---

## Step 4: Configure OpenClaw

Edit `~/.openclaw/openclaw.json`. You need to add two things to the `plugins` section.

### 4a. Read the current config

```bash
cat ~/.openclaw/openclaw.json
```

### 4b. Add the plugin load path

Under `plugins.load.paths`, add the **absolute path** to the remoteclaw directory:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/remoteclaw"
      ]
    }
  }
}
```

**CRITICAL**: Use `plugins.load.paths`, NOT symlinks in `~/.openclaw/extensions/`. The extensions scanner uses `readdir` with `withFileTypes` which does NOT follow symlinks (`isDirectory()` returns `false` for symlinks). The `plugins.load.paths` codepath uses `statSync` which follows symlinks correctly.

If `plugins.load.paths` already exists with other entries, append to the array — don't replace it.

### 4c. Add the plugin entry with config

Under `plugins.entries`, add a `remoteclaw` entry:

```json
{
  "plugins": {
    "entries": {
      "remoteclaw": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "<gateway.auth.token value from the config>",
          "sessionKey": "main",
          "port": 3100
        }
      }
    }
  }
}
```

Config fields:

| Field | Default | Required | Description |
|-------|---------|----------|-------------|
| `gatewayUrl` | `http://localhost:18789` | No | Gateway URL for tool invocation |
| `gatewayToken` | — | Yes (if auth enabled) | Bearer token from `gateway.auth.token` |
| `sessionKey` | `main` | No | Session key for tool invocations |
| `port` | `3100` | No | Port for the RemoteClaw MCP server |
| `tlsCert` | — | No | Path to TLS cert (auto-detects `certs/` dir) |
| `tlsKey` | — | No | Path to TLS key (auto-detects `certs/` dir) |

**IMPORTANT**: The config must be nested under `config` inside the entry. `api.pluginConfig` reads from `plugins.entries.<id>.config` (the nested object), NOT from the entry itself. Getting this wrong means the plugin gets an empty config.

### 4d. Validate the config structure

After editing, verify the JSON is valid:

```bash
python3 -c "import json; json.load(open('$HOME/.openclaw/openclaw.json'))" && echo "Valid JSON" || echo "INVALID JSON"
```

### Example: Complete plugins section

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/Users/me/projects/openclaw-mcp/remoteclaw"
      ]
    },
    "entries": {
      "remoteclaw": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "your-token-here",
          "sessionKey": "main",
          "port": 3100
        }
      }
    }
  }
}
```

---

## Step 5: Restart the Gateway

The gateway must be restarted to pick up the new plugin.

```bash
openclaw gateway stop
```

Wait 3 seconds, then:

```bash
openclaw gateway install
```

Or via launchctl directly:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
sleep 3
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

**Wait at least 5 seconds** after restart for the plugin service to initialize. Dynamic tool discovery imports the full OpenClaw tool graph, which takes a moment on first load.

---

## Step 6: Verify the Setup

Run these checks in order. Each must pass before proceeding.

### 6a. Gateway is running

```bash
curl -s http://127.0.0.1:18789/v1/models | head -c 200
```

Should return a JSON response. If connection refused, the gateway didn't start — check logs:

```bash
tail -50 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log
```

### 6b. RemoteClaw health endpoint

**HTTP:**
```bash
curl http://127.0.0.1:3100/health
```

**HTTPS:**
```bash
curl https://127.0.0.1:3100/health
```

Expected response:
```json
{"ok":true,"tools":19,"sessions":0,"tls":true}
```

- `tools` > 0 confirms tool discovery worked
- `tools` around 16-20 means dynamic discovery succeeded (built-in + plugin tools)
- `tls: true` means HTTPS is active (only if certs were set up)

If connection refused, the plugin service didn't start. Check gateway logs for `[remoteclaw]` entries:

```bash
grep -i "remoteclaw" ~/.openclaw/logs/gateway.log | tail -20
```

### 6c. Tool list via gateway HTTP route

```bash
curl -s http://127.0.0.1:18789/tools/list | python3 -c "import sys,json; tools=json.load(sys.stdin); print(f'{len(tools)} tools:'); [print(f'  - {t[\"name\"]}') for t in tools]"
```

This lists all dynamically discovered tools (before MCP conversion, without native tools). Expected: ~19 tools including built-in ones like `web_search`, `browser`, plus any plugin-registered tools.

### 6d. MCP handshake test

**HTTP:**
```bash
curl -X POST http://127.0.0.1:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

**HTTPS:**
```bash
curl -X POST https://127.0.0.1:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

Expected: SSE response containing `serverInfo: { name: "remoteclaw", version: "0.1.0" }`.

### 6e. Full MCP tool listing (optional, thorough)

This Python script does a full MCP handshake and lists all tools:

```python
import json, http.client, ssl

# Use ssl for HTTPS, or http.client.HTTPConnection for HTTP
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

conn = http.client.HTTPSConnection("127.0.0.1", 3100, context=ctx)
# For HTTP: conn = http.client.HTTPConnection("127.0.0.1", 3100)

headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
}

# Initialize
conn.request("POST", "/mcp", json.dumps({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "1.0"}
    }
}), headers)
resp = conn.getresponse()
session_id = resp.getheader("mcp-session-id")
resp.read()

# Send initialized notification
headers["mcp-session-id"] = session_id
conn.request("POST", "/mcp", json.dumps({
    "jsonrpc": "2.0", "method": "notifications/initialized"
}), headers)
conn.getresponse().read()

# List tools
conn.request("POST", "/mcp", json.dumps({
    "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
}), headers)
body = conn.getresponse().read().decode()
for line in body.split("\n"):
    if line.startswith("data: "):
        data = json.loads(line[6:])
        tools = data.get("result", {}).get("tools", [])
        print(f"\n{len(tools)} MCP tools available:")
        for t in tools:
            print(f"  - {t['name']}: {t['description'][:70]}")
```

Expected: 25+ tools (19 discovered + 6 native: `openclaw_chat`, `openclaw_status`, `openclaw_chat_async`, `openclaw_task_status`, `openclaw_task_list`, `openclaw_task_cancel`).

---

## Step 7: Connect an MCP Client

### Claude Code

Create `.mcp.json` in your project directory (or `~/.claude/.mcp.json` for global):

**HTTPS:**
```json
{
  "mcpServers": {
    "remoteclaw": {
      "type": "http",
      "url": "https://127.0.0.1:3100/mcp"
    }
  }
}
```

**HTTP:**
```json
{
  "mcpServers": {
    "remoteclaw": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "remoteclaw": {
      "url": "https://127.0.0.1:3100/mcp"
    }
  }
}
```

### Programmatic (Node.js)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://127.0.0.1:3100/mcp')
);
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`${tools.length} tools available`);

const result = await client.callTool({
  name: 'web_search',
  arguments: { query: 'hello world' }
});
console.log(result);
```

---

## Troubleshooting

### "plugin not found: remoteclaw"

The plugin wasn't discovered during config validation.

1. Verify `plugins.load.paths` contains the **absolute** path to the remoteclaw directory
2. Check the directory has both `openclaw.plugin.json` AND `package.json`
3. `package.json` must have `"openclaw": { "extensions": ["./src/index.ts"] }`
4. `openclaw.plugin.json` must have `"id": "remoteclaw"` and a `"configSchema"` — the loader rejects plugins without a config schema

**Do NOT** use symlinks in `~/.openclaw/extensions/`. They won't be followed.

### Health endpoint: connection refused

The MCP server didn't start. Check gateway logs:

```bash
grep -i "remoteclaw\|Discovered\|Dynamic" ~/.openclaw/logs/gateway.log | tail -20
```

Common causes:
- Port 3100 already in use — change `port` in the plugin config
- Dynamic discovery failed and no static catalog — look for "using static catalog" or "No tools found"
- Plugin config is malformed — validate the JSON

### Health returns `"tools": 0`

Neither dynamic discovery nor the static catalog found tools.

- **Dynamic discovery** requires the OpenClaw dev source at `~/projects/openclaw` (or set `openclawRoot` in plugin config, or set `OPENCLAW_ROOT` env var). The source must have `src/agents/openclaw-tools.ts`.
- **Static catalog fallback** requires `src/tool-catalog.json` in the remoteclaw source (generated by `npm run refresh-catalog`). For refresh-catalog to work, the OpenClaw dev source needs a `node_modules/` — symlink it from the installed package if needed: `ln -s $(dirname $(which openclaw))/../lib/node_modules/openclaw/node_modules ~/projects/openclaw/node_modules`

### Tool returns "not_found" from gateway

The gateway has a tool deny list for HTTP access. Add the tool to the allow list:

```json
{
  "gateway": {
    "tools": {
      "allow": ["tool_name"]
    }
  }
}
```

### HTTPS: ECONNRESET or certificate errors

1. `certs/` must contain `localhost+2.pem` and `localhost+2-key.pem` (generated by mkcert)
2. Run `mkcert -install` once to trust the local CA system-wide
3. Match the URL protocol to the server mode — if health reports `"tls":true`, use `https://`
4. Restart gateway after adding/removing certs (TLS mode is set at startup)
5. For Node.js clients: `export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"`

### Gateway restart fails ("port already in use")

```bash
openclaw gateway stop
sleep 5
openclaw gateway install
```

If that fails, force-kill:

```bash
lsof -ti:18789 | xargs kill
sleep 2
openclaw gateway install
```

### "plugin id mismatch" warning

This is a warning, not an error. It means the `id` in `openclaw.plugin.json` doesn't match the key used in `plugins.entries`. Make sure they're both `"remoteclaw"`.

### Changes not taking effect after code edit

After editing any RemoteClaw source:

```bash
cd /path/to/remoteclaw
npm run build
openclaw gateway stop
sleep 3
openclaw gateway install
```

The gateway loads the plugin from the `src/` entry point (via jiti), but the build is needed for the static catalog fallback and for any consumers importing from `dist/`.

---

## Quick Reference

| Endpoint | URL | Purpose |
|----------|-----|---------|
| MCP | `https://127.0.0.1:3100/mcp` | MCP protocol (for clients) |
| Health | `https://127.0.0.1:3100/health` | Server status + tool count |
| Tool list | `http://127.0.0.1:18789/tools/list` | Raw discovered tools (gateway route) |

| Native tool | Description |
|-------------|-------------|
| `openclaw_chat` | Sync chat with OpenClaw |
| `openclaw_status` | Gateway health check |
| `openclaw_chat_async` | Async chat, returns task_id |
| `openclaw_task_status` | Poll async task result |
| `openclaw_task_list` | List all tasks |
| `openclaw_task_cancel` | Cancel pending task |
