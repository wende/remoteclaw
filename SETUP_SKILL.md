# RemoteClaw Setup Skill

You are setting up the **RemoteClaw** OpenClaw plugin from scratch. RemoteClaw exposes every OpenClaw tool (built-in + plugin-registered) as individual MCP tools, letting MCP clients call `web_search`, `browser`, `sessions_send`, etc. directly — bypassing the single-chat-proxy pattern.

## Contents

- [Step 0: Gather Requirements](#step-0-gather-requirements)
- [Architecture Overview](#architecture-overview)
- [Step 1: Check Prerequisites](#step-1-check-prerequisites)
- [Step 2: Install Dependencies and Build](#step-2-install-dependencies-and-build)
- [Step 3: Set Up TLS](#step-3-set-up-tls-optional--required-for-claudeai)
- [Step 4: Configure OpenClaw](#step-4-configure-openclaw)
- [Step 5: Restart the Gateway](#step-5-restart-the-gateway)
- [Step 6: Verify the Setup](#step-6-verify-the-setup)
- [Step 7: Connect an MCP Client](#step-7-connect-an-mcp-client)
- [Step 8: Remote Access with OAuth 2.1](#step-8-remote-access-with-oauth-21)
  - [Why You Need a Tunnel](#why-you-need-a-tunnel)
  - [Option A: Cloudflare Tunnel (Recommended)](#option-a-cloudflare-tunnel-recommended)
  - [Option B: ngrok](#option-b-ngrok)
  - [Tailscale Funnel (Does NOT Work)](#tailscale-funnel-does-not-work)
  - [Configure OAuth in RemoteClaw](#configure-oauth-in-remoteclaw)
  - [Verify the OAuth Setup](#verify-the-oauth-setup)
- [Troubleshooting](#troubleshooting)
- [Quick Reference](#quick-reference)

---

## Step 0: Gather Requirements

**Before starting any setup, ask the user the following questions.** Their answers determine which steps to execute and which to skip. Present all questions at once (not one at a time) and wait for answers before proceeding.

### Question 1: Which MCP client will you use?

Ask the user which client(s) they plan to connect to RemoteClaw:

- **Claude Code** (CLI) — runs locally, connects over localhost
- **Claude Desktop** (app) — runs locally, connects over localhost
- **Claude.ai** (browser) — runs remotely, requires a public HTTPS URL + OAuth
- **Programmatic / other** — custom Node.js/Python client

*Why this matters:* Claude.ai requires remote access (tunnel + OAuth + TLS), while local clients can use plain HTTP. This is the single biggest factor in setup complexity.

### Question 2: HTTP or HTTPS?

Ask the user whether they want the local MCP server to use HTTP or HTTPS:

- **HTTP** (simpler) — No TLS setup needed. Works perfectly for local-only access (Claude Code/Desktop on the same machine). The MCP protocol works identically over HTTP. Choose this if you don't need remote access and want the fastest setup.
- **HTTPS** (more secure) — Requires generating TLS certificates via `mkcert` and configuring `NODE_EXTRA_CA_CERTS` for Node.js clients. Required if connecting Claude.ai (the tunnel still terminates TLS at Cloudflare's edge, but the local origin must also serve HTTPS for the tunnel to forward correctly). Also recommended if other users/processes on the machine shouldn't be able to sniff MCP traffic.

**Recommendation based on Question 1:**
- If **Claude.ai** was selected → HTTPS is required (auto-select it)
- If **only local clients** → recommend HTTP for simplicity, but let the user choose HTTPS if they prefer

### Question 3: Do you need remote access (OAuth + tunnel)?

Ask the user if they need to access RemoteClaw from outside the local machine:

- **No** — Local only. Skip Step 8 entirely. No tunnel, no OAuth.
- **Yes** — Remote access needed. This requires a tunnel (public HTTPS URL) and OAuth 2.1 authentication to prevent unauthorized access.

If **Claude.ai** was selected in Question 1, auto-select "Yes" — Claude.ai always requires remote access.

If the user selects "Yes", also ask:

#### Question 3b: Which tunnel provider?

- **Cloudflare Tunnel (Recommended)** — Free, no account needed for quick tunnels. Stable URLs available with a free Cloudflare account. Best reliability and performance.
- **ngrok** — Free tier available, requires account signup. Simple setup. Free URLs change on restart; stable URLs require a paid plan.

### Question 4: Custom port?

Ask the user if the default port (3100) is acceptable, or if they need a different port.

*Why this matters:* If port 3100 is already in use by another service, the plugin will fail to start. Better to ask upfront than debug later.

---

### How to use the answers

After gathering answers, execute only the relevant steps:

| Scenario | Steps to execute |
|----------|-----------------|
| Local client + HTTP | 1, 2, 4, 5, 6, 7 (skip 3 and 8) |
| Local client + HTTPS | 1, 2, 3, 4, 5, 6, 7 (skip 8) |
| Claude.ai (remote) | 1, 2, 3, 4, 5, 6, 7, 8 (all steps) |

When executing steps, use the HTTP or HTTPS variants of commands/configs based on the user's choice. For example, in Step 6 verification, use `curl http://...` or `curl https://...` accordingly. In Step 7, provide the matching `.mcp.json` config.

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

### 3d. For Node.js MCP clients (Claude Code)

Node.js uses its own certificate store, not the system one. Even after `mkcert -install`, Node.js processes won't trust the mkcert CA unless you tell them where to find it.

**Important**: `NODE_EXTRA_CA_CERTS` is read once at Node.js process startup — it cannot be set at runtime. You must set it in the shell **before** launching Claude Code.

Add this to `~/.bashrc` **before the interactive guard** (`[ -z "$PS1" ] && return` or similar), so it applies to all bash invocations including non-interactive subshells:

```bash
# Trust mkcert CA for Node.js (must be before interactive guard)
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

Then reload your shell or source it:

```bash
source ~/.bashrc
```

Verify it's set correctly:

```bash
echo $NODE_EXTRA_CA_CERTS
# Should print something like /home/user/.local/share/mkcert/rootCA.pem
ls -la "$NODE_EXTRA_CA_CERTS"
# Should show the file exists
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

## Step 8: Remote Access with OAuth 2.1

Steps 1-7 cover **local** access (Claude Code/Desktop on the same machine). To connect **remote** clients like Claude.ai, you need two things:

1. A public HTTPS URL pointing to your RemoteClaw instance (via a tunnel)
2. OAuth 2.1 authentication to prevent unauthorized access

### Why You Need a Tunnel

RemoteClaw listens on `127.0.0.1:3100` — not reachable from the internet. Claude.ai runs in the browser and needs a publicly-routable HTTPS URL to connect to your MCP server. A tunnel creates that public URL and forwards traffic to your local server.

### Option A: Cloudflare Tunnel (Recommended)

Cloudflare Tunnel (`cloudflared`) creates a secure tunnel from a Cloudflare-managed URL to your local server. No port forwarding, no public IP needed.

#### Install cloudflared

```bash
# macOS
brew install cloudflared

# Linux (user-local, no sudo needed)
mkdir -p ~/.local/bin
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared
chmod +x ~/.local/bin/cloudflared
# Ensure ~/.local/bin is in PATH (add to ~/.bashrc if not already):
#   export PATH="$HOME/.local/bin:$PATH"

# Alternative: system-wide (requires sudo)
# sudo curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
# sudo chmod +x /usr/local/bin/cloudflared
```

#### Quick tunnel (no Cloudflare account needed)

```bash
cloudflared tunnel --url https://127.0.0.1:3100
```

This prints a URL like `https://random-words.trycloudflare.com`. Use that as your `issuerUrl` in the OAuth config and as the MCP endpoint URL in Claude.ai.

**Note**: Quick tunnels generate a new random URL each time. For a stable URL, create a named tunnel with a Cloudflare account.

#### Named tunnel (stable URL, requires free Cloudflare account)

```bash
cloudflared tunnel login
cloudflared tunnel create remoteclaw
cloudflared tunnel route dns remoteclaw mcp.yourdomain.com
cloudflared tunnel run --url https://127.0.0.1:3100 remoteclaw
```

This gives you a stable `https://mcp.yourdomain.com` that persists across restarts.

#### Important: TLS to origin

Since RemoteClaw runs with TLS locally (self-signed via mkcert), tell cloudflared to skip origin certificate verification:

```bash
cloudflared tunnel --url https://127.0.0.1:3100 --no-tls-verify
```

Or if running without TLS locally:

```bash
cloudflared tunnel --url http://127.0.0.1:3100
```

### Option B: ngrok

ngrok creates a public HTTPS URL forwarding to your local server. Free tier available.

#### Install ngrok

```bash
# macOS
brew install ngrok

# Linux / other — see https://ngrok.com/download
```

#### Sign up and configure auth token

```bash
# Sign up at https://ngrok.com, then:
ngrok config add-authtoken YOUR_TOKEN
```

#### Start the tunnel

For a local HTTPS origin (self-signed cert):

```bash
ngrok http https://127.0.0.1:3100 --scheme=https
```

For a local HTTP origin:

```bash
ngrok http 3100
```

ngrok prints a URL like `https://abcd1234.ngrok-free.app`. Use that as your `issuerUrl` and MCP endpoint.

**Note**: Free-tier ngrok URLs change on each restart. Paid plans offer stable custom domains.

### Tailscale Funnel (Does NOT Work)

**Do NOT use Tailscale Funnel for MCP.** While Tailscale Funnel can expose local services publicly, it does not work with the MCP protocol because:

1. **SSE streaming incompatibility** — Tailscale Funnel buffers HTTP responses before forwarding. MCP's Streamable HTTP transport uses Server-Sent Events (SSE), which requires the proxy to stream response bytes as they arrive. Funnel's buffering breaks the SSE stream — the client sees a timeout or empty response instead of the event stream.
2. **No bidirectional streaming support** — MCP sessions require long-lived HTTP connections with interleaved request/response patterns. Funnel is designed for simple request/response HTTP, not persistent streaming.

If you're already using Tailscale for other things, use Cloudflare Tunnel or ngrok alongside it for the MCP endpoint specifically.

### Configure OAuth in RemoteClaw

Once your tunnel is running and you have a public URL, enable OAuth to secure the endpoint.

#### Generate credentials

```bash
# Generate a client ID and secret
export MCP_CLIENT_ID=$(openssl rand -hex 16)
export MCP_CLIENT_SECRET=$(openssl rand -hex 32)
echo "Client ID:     $MCP_CLIENT_ID"
echo "Client Secret: $MCP_CLIENT_SECRET"
```

Save these values — you'll need the client ID and secret to configure the MCP client.

#### Update the plugin config

Edit `~/.openclaw/openclaw.json` and add auth fields to the remoteclaw plugin config:

```json
{
  "plugins": {
    "entries": {
      "remoteclaw": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "your-gateway-token",
          "sessionKey": "main",
          "port": 3100,
          "authEnabled": true,
          "clientId": "your-generated-client-id",
          "clientSecret": "your-generated-client-secret",
          "issuerUrl": "https://your-tunnel-url.example.com",
          "corsOrigins": "*"
        }
      }
    }
  }
}
```

Config fields for auth:

| Field | Default | Required | Description |
|-------|---------|----------|-------------|
| `authEnabled` | `false` | No | Enable OAuth 2.1 on `/mcp` endpoints |
| `clientId` | — | Yes (if auth on) | OAuth client ID |
| `clientSecret` | — | Yes (if auth on) | OAuth client secret |
| `issuerUrl` | auto | No | Public URL of this server (your tunnel URL). If omitted, defaults to `https://127.0.0.1:PORT` |
| `corsOrigins` | `*` | No | Comma-separated allowed CORS origins, `*` for all, `none` to disable |

**`issuerUrl` is critical** — it must match the public URL that clients use to reach you. The OAuth metadata endpoint (`.well-known/oauth-authorization-server`) advertises authorization and token endpoints based on this URL. If it doesn't match the tunnel URL, clients will try to reach `127.0.0.1` for token exchange and fail.

> **Why `issuerUrl` matters even beyond OAuth:**
>
> `issuerUrl` serves **two purposes**:
> 1. **OAuth metadata base URL** — the `.well-known` endpoints use it to advertise authorization/token URLs
> 2. **Express host-header allowlist** — the hostname from `issuerUrl` is added to the `allowedHosts` list for the MCP SDK's `createMcpExpressApp`
>
> Without `issuerUrl`, tunnel requests are rejected with **"Invalid Host"** because the MCP SDK only allows `127.0.0.1` / `localhost` by default. When a Cloudflare or ngrok tunnel forwards a request, the `Host` header is the tunnel domain (e.g., `random-words.trycloudflare.com`), which doesn't match the default allowlist.
>
> This is why `issuerUrl` must be set for **any** tunnel-based access, even if you're not using OAuth — though in practice, you should always enable OAuth for remote access.

#### Restart the gateway

```bash
openclaw gateway stop
sleep 3
openclaw gateway install
```

### Verify the OAuth Setup

#### Check health shows auth enabled

```bash
curl https://your-tunnel-url.example.com/health
```

Expected:
```json
{"ok":true,"tools":19,"sessions":0,"tls":true,"auth":true}
```

#### Check OAuth metadata is served

```bash
curl https://your-tunnel-url.example.com/.well-known/oauth-authorization-server
```

Should return JSON with `authorization_endpoint`, `token_endpoint`, etc. — all using your tunnel URL as the base.

#### Check /mcp requires auth

```bash
curl -X POST https://your-tunnel-url.example.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Should return **401 Unauthorized**.

#### Connect from Claude.ai

In Claude.ai's MCP server configuration, add the server URL:

```
https://your-tunnel-url.example.com/mcp
```

Claude.ai will:
1. Discover the OAuth metadata via `.well-known/oauth-authorization-server`
2. Redirect you to the authorization endpoint
3. Auto-approve (no consent screen — credentials are the gate)
4. Exchange the auth code for tokens
5. Connect to `/mcp` with the Bearer token

You'll need to provide the `client_id` and `client_secret` during the OAuth flow if Claude.ai prompts for them.

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

### Claude Code MCP connection fails instantly (~10-20ms)

**Symptom**: `curl` to the health endpoint works fine, but Claude Code's `fetch()` fails immediately with `TypeError: fetch failed` and no useful error code. The connection fails in ~10-20ms — much faster than a network timeout.

**Cause**: Node.js TLS handshake is rejecting the mkcert certificate because the mkcert CA isn't trusted by Node's certificate store.

**Fix**:

1. Ensure `mkcert -install` was run (installs the CA into the system trust store)
2. Ensure `NODE_EXTRA_CA_CERTS` is set in the shell that launches Claude Code:

```bash
echo $NODE_EXTRA_CA_CERTS
# Should print a path like /home/user/.local/share/mkcert/rootCA.pem

ls -la "$NODE_EXTRA_CA_CERTS"
# Should show the file exists and is readable
```

3. If the variable is unset or the file doesn't exist, add it to `~/.bashrc` (see Step 3d) and **restart your terminal** before launching Claude Code

**Key insight**: Unlike `curl` (which uses the system trust store), Node.js ignores system CAs for custom roots. The `NODE_EXTRA_CA_CERTS` env var bridges this gap.

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

| Endpoint | URL | Auth | Purpose |
|----------|-----|------|---------|
| MCP | `https://127.0.0.1:3100/mcp` | Bearer (if enabled) | MCP protocol (for clients) |
| Health | `https://127.0.0.1:3100/health` | None | Server status + tool count |
| Tool list | `http://127.0.0.1:18789/tools/list` | None | Raw discovered tools (gateway route) |
| OAuth metadata | `.../.well-known/oauth-authorization-server` | None | OAuth 2.1 server discovery |
| Authorize | `.../authorize` | None | OAuth authorization endpoint |
| Token | `.../token` | None | OAuth token exchange |

| Native tool | Description |
|-------------|-------------|
| `openclaw_chat` | Sync chat with OpenClaw |
| `openclaw_status` | Gateway health check |
| `openclaw_chat_async` | Async chat, returns task_id |
| `openclaw_task_status` | Poll async task result |
| `openclaw_task_list` | List all tasks |
| `openclaw_task_cancel` | Cancel pending task |
