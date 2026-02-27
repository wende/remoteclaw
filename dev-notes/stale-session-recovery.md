# Stale Session Recovery

## The Problem

After a gateway restart (`kill -USR1`), all MCP sessions are destroyed (the `sessions` Map is cleared). But MCP clients (Claude Code, Claude Desktop) don't know this — they keep sending requests with the old `mcp-session-id` header.

The MCP SDK's `StreamableHTTPServerTransport` requires `initialize` as the first method per session. A tool call on a non-existent session triggers `validateSession()` which rejects with "Server not initialized".

Result: after every gateway restart, MCP clients are stuck until manually reconnected.

## The Fix

Added auto-recovery logic in `src/index.ts` that detects stale session IDs and transparently creates a new session:

```typescript
if (sessionId && !sessions.has(sessionId)) {
  // 1. Create a fresh Server + Transport pair
  const session = createSession();
  await session.server.connect(session.transport);

  // 2. Synthesize an 'initialize' request via the internal web standard transport
  const wst = (session.transport as any)._webStandardTransport;
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'remoteclaw-recovery', version: '0.1.0' },
    },
    id: `_init_${randomUUID()}`,
  });

  const initReq = new Request(`${proto}://localhost:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
    },
    body: initBody,
  });
  await wst.handleRequest(initReq, {});

  // 3. Register the new session and forward the original request
  const newSid = session.transport.sessionId;
  sessions.set(newSid, session);

  req.headers['mcp-session-id'] = newSid;
  if (!req.headers['mcp-protocol-version']) {
    req.headers['mcp-protocol-version'] = '2025-03-26';
  }
  await session.transport.handleRequest(req, res);
  return;
}
```

## How It Works

1. Request arrives with `mcp-session-id: <old-id>`
2. `sessions.has(oldId)` returns `false` — session is stale
3. Create a new `Server` + `StreamableHTTPServerTransport` pair
4. Access the internal `_webStandardTransport` (the actual `WebStandardStreamableHTTPServerTransport`)
5. Send a synthetic `initialize` JSON-RPC request to it — this sets `_initialized = true` and generates a new session ID
6. Store the new session, rewrite the request headers, and forward the original request

The client doesn't know any of this happened. From its perspective, the tool call just worked (slightly slower due to the extra init round-trip).

## MCP SDK Internals

`StreamableHTTPServerTransport` wraps `WebStandardStreamableHTTPServerTransport`:
- `_initialized` flag (set `true` after processing an `initialize` request)
- `sessionId` — generated during `initialize` processing
- `validateSession()` — rejects non-initialized requests with "Server not initialized"
- `handleRequest()` — the public method; delegates to the web standard transport

The internal transport is exposed as `._webStandardTransport` (private but accessible).

## Gotcha: Protocol Version Header

The MCP SDK also validates `mcp-protocol-version` on non-initialize requests. If the client's original request doesn't include this header (some SDK versions omit it), the recovery must inject it. We use `'2025-03-26'` which is the current protocol version.

## File Changes

| File | Change |
|------|--------|
| `src/index.ts` | Added stale session detection and auto-recovery block in the `/mcp` POST handler |
