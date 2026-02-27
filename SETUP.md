# RemoteClaw Setup Guide

RemoteClaw is an OpenClaw plugin that exposes all OpenClaw tools as individual MCP tools. Instead of a single `openclaw_chat` proxy, it lets MCP clients (Claude Desktop, Claude Code, Claude.ai, etc.) call `web_search`, `browser`, `sessions_send`, and every other tool directly — with zero model-inference overhead.

## Prerequisites

- **Node.js** >= 20
- **OpenClaw** installed and running (`openclaw gateway` on default port 18789)
- **OpenClaw source tree** cloned locally (needed for catalog generation)

## 1. Clone and Install

```bash
git clone <repo-url>
cd remoteclaw
npm install
```

## 2. Generate the Tool Catalog

The tool catalog is a static JSON file extracted from the OpenClaw source tree. It contains the name, description, and JSON Schema for every tool.

### Set up package resolution for the source tree

The OpenClaw dev source needs a `node_modules/` directory for its imports to resolve. If one doesn't exist, symlink it from the installed package:

```bash
# Find where openclaw is installed
OPENCLAW_INSTALL=$(dirname $(which openclaw))/../lib/node_modules/openclaw

# Symlink node_modules into the dev source
ln -s "$OPENCLAW_INSTALL/node_modules" ~/projects/openclaw/node_modules
```

### Run the generator

```bash
npm run refresh-catalog
# or, with a custom source path:
node scripts/generate-catalog.cjs /path/to/openclaw-source
```

This writes `src/tool-catalog.json` with all discovered tools. Verify the output lists the expected tools (currently 16).

## 3. Configure OpenClaw

Edit `~/.openclaw/openclaw.json` and add two things:

### a) Plugin load path

Add a `plugins.load` section pointing to the remoteclaw directory:

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

> **Why not `~/.openclaw/extensions/`?** The global extensions scanner uses `readdir` with `withFileTypes`, which does not follow symlinks. Using `plugins.load.paths` avoids this issue entirely and works with both real directories and symlinks.

### b) Plugin entry with config

Add a `remoteclaw` entry under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "remoteclaw": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "<your-gateway-auth-token>",
          "sessionKey": "main",
          "port": 3100
        }
      }
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `gatewayUrl` | `http://localhost:18789` | OpenClaw gateway URL |
| `gatewayToken` | — | Bearer token from `gateway.auth.token` in your config |
| `sessionKey` | `main` | Session key for tool invocations |
| `port` | `3100` | Port for the MCP HTTP server |

Your gateway token is in `~/.openclaw/openclaw.json` under `gateway.auth.token`.

## 4. Choose a Transport: HTTP or HTTPS

RemoteClaw supports both plain HTTP and HTTPS. Choose based on your MCP client:

| Client | Required Transport |
|--------|-------------------|
| Claude Code (local) | HTTP or HTTPS |
| Claude Desktop (local) | HTTP or HTTPS |
| Claude.ai (remote) | **HTTPS only** |
| Custom MCP clients | HTTP or HTTPS |

### Option A: HTTP (simplest)

No extra setup needed. The server starts on HTTP by default.

Skip ahead to [Step 5: Restart the Gateway](#5-restart-the-gateway).

### Option B: HTTPS (required for Claude.ai)

HTTPS is required when your MCP client enforces `https://` URLs (e.g., Claude.ai). RemoteClaw auto-detects TLS certificates in its `certs/` directory.

#### Install mkcert

[mkcert](https://github.com/FiloSottile/mkcert) creates locally-trusted TLS certificates — no self-signed cert warnings.

```bash
# macOS
brew install mkcert

# Linux
# See https://github.com/FiloSottile/mkcert#installation
```

#### Install the local CA

This adds mkcert's root CA to your system trust store so browsers, curl, and Node.js all trust the certificates:

```bash
mkcert -install
```

> **Note:** This may require `sudo` and only needs to be done once per machine.

#### Generate certificates

```bash
cd remoteclaw
mkdir -p certs
cd certs
mkcert localhost 127.0.0.1 ::1
cd ..
```

This creates two files in `certs/`:
- `localhost+2.pem` — certificate
- `localhost+2-key.pem` — private key

RemoteClaw **auto-detects** these files on startup. No config changes needed.

#### Manual TLS paths (optional)

If your certs are stored elsewhere, set explicit paths in the plugin config:

```json
{
  "plugins": {
    "entries": {
      "remoteclaw": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "<your-token>",
          "tlsCert": "/path/to/cert.pem",
          "tlsKey": "/path/to/key.pem"
        }
      }
    }
  }
}
```

## 5. Restart the Gateway

```bash
openclaw gateway install
```

Or manually via launchctl:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

Wait ~3 seconds for the plugin service to start.

## 6. Verify

### Health check

**HTTP:**
```bash
curl http://127.0.0.1:3100/health
# Expected: {"ok":true,"tools":16,"tls":false}
```

**HTTPS:**
```bash
curl https://127.0.0.1:3100/health
# Expected: {"ok":true,"tools":16,"tls":true}
```

> If you skipped `mkcert -install`, you'll need `curl -k` to bypass certificate verification. This is not recommended — just run `mkcert -install`.

### Plugin status

```bash
openclaw plugins list
# remoteclaw should show as "loaded" with services: ["remoteclaw"]
```

### MCP handshake test

Replace `http` with `https` if using TLS:

```bash
curl -X POST http://127.0.0.1:3100/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

Should return a JSON-RPC response with `serverInfo: { name: "remoteclaw" }`.

## 7. Connect an MCP Client

### Claude Code

Create a `.mcp.json` file in your project directory:

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

### Claude Desktop

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

**HTTP:**
```json
{
  "mcpServers": {
    "remoteclaw": {
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

**HTTPS:**
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
  new URL('https://127.0.0.1:3100/mcp') // or http:// without TLS
);
const client = new Client({ name: 'my-app', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const result = await client.callTool({ name: 'web_search', arguments: { query: 'hello' } });
```

## Troubleshooting

### "plugin not found: remoteclaw"

The plugin wasn't discovered. Check:
1. `plugins.load.paths` contains the absolute path to the remoteclaw directory
2. The directory has a valid `openclaw.plugin.json` and `package.json`
3. `package.json` has `"openclaw": { "extensions": ["./src/index.ts"] }`

### Empty tool catalog

Run `npm run refresh-catalog` and ensure:
1. OpenClaw source tree exists at the expected path
2. `~/projects/openclaw/node_modules` exists (symlink or real)
3. `jiti` is installed (`npm install` in remoteclaw)

### Port already in use

Change the port in `plugins.entries.remoteclaw.config.port` and restart the gateway.

### Tool returns "not_found" from gateway

The tool may be on the gateway's HTTP deny list. Add it to `gateway.tools.allow` in `openclaw.json`:

```json
{
  "gateway": {
    "tools": {
      "allow": ["tool_name"]
    }
  }
}
```

### HTTPS: ECONNRESET or connection refused

1. Make sure `certs/` has the mkcert-generated files (`localhost+2.pem` and `localhost+2-key.pem`)
2. Run `mkcert -install` to trust the local CA (needs to be done once per machine)
3. Verify the URL protocol matches the server mode — if the health endpoint reports `"tls":true`, use `https://`
4. Restart the gateway after adding/removing certs (the TLS mode is determined at startup)

### HTTPS: Node.js doesn't trust the certificate

If you see `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar in a Node.js client, point it to the mkcert CA:

```bash
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
```

### Single client limitation

The current design supports one MCP client connection at a time. If a previous client disconnected uncleanly, restart the gateway to reset the transport state.
