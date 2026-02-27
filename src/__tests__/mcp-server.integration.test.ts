import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRemoteClawServer } from '../mcp-server.js';
import type { AgentTool } from '../types.js';
import { ToolInvoker } from '../tool-invoker.js';
import { NativeToolHandler, nativeToolDefinitions } from '../native-tools.js';
import { OpenClawClient } from '../openclaw-client.js';
import { TaskManager } from '../task-manager.js';

function makeMockTools(): AgentTool[] {
  return [
    {
      name: 'web_search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
    {
      name: 'read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
    {
      name: 'screenshot',
      description: 'Take a screenshot',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

async function setupClientServer(
  tools: AgentTool[] | (() => AgentTool[]),
  fetchImpl?: typeof globalThis.fetch
) {
  if (fetchImpl) {
    vi.stubGlobal('fetch', fetchImpl);
  }

  const invoker = new ToolInvoker('http://localhost:18789', 'test-token');
  const server = createRemoteClawServer({ tools, invoker });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, invoker };
}

describe('MCP Server Integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists all discovered tools via client.listTools()', async () => {
    const { client } = await setupClientServer(makeMockTools());
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain('web_search');
    expect(names).toContain('read');
    expect(names).toContain('screenshot');
  });

  it('tool inputSchema preserves JSON Schema properties and required fields', async () => {
    const { client } = await setupClientServer(makeMockTools());
    const { tools } = await client.listTools();

    const webSearch = tools.find((t) => t.name === 'web_search')!;
    expect(webSearch.inputSchema.type).toBe('object');
    expect(webSearch.inputSchema.properties).toHaveProperty('query');
    expect(webSearch.inputSchema.required).toEqual(['query']);

    expect(webSearch.description).toBe('Search the web');
  });

  it('calls a tool and returns text result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            ok: true,
            result: { content: [{ type: 'text', text: 'search results here' }] },
          })
        ),
    });

    const { client } = await setupClientServer(makeMockTools(), fetchSpy);
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'test' } });

    expect(result.content).toEqual([{ type: 'text', text: 'search results here' }]);
    expect(result.isError).toBeFalsy();
  });

  it('calls a tool and returns image result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            ok: true,
            result: {
              content: [{ type: 'image', data: 'base64screenshot', mimeType: 'image/png' }],
            },
          })
        ),
    });

    const { client } = await setupClientServer(makeMockTools(), fetchSpy);
    const result = await client.callTool({ name: 'screenshot', arguments: {} });

    expect(result.content).toEqual([
      { type: 'image', data: 'base64screenshot', mimeType: 'image/png' },
    ]);
  });

  it('returns isError: true when /tools/invoke returns { ok: false }', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ ok: false, error: 'permission denied' })),
    });

    const { client } = await setupClientServer(makeMockTools(), fetchSpy);
    const result = await client.callTool({ name: 'read', arguments: { path: '/etc/shadow' } });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'permission denied' }]);
  });

  it('returns isError: true when HTTP request fails', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('crash'),
    });

    const { client } = await setupClientServer(makeMockTools(), fetchSpy);
    const result = await client.callTool({ name: 'read', arguments: { path: '/tmp/x' } });

    expect(result.isError).toBe(true);
  });

  it('forwards unknown tool names to gateway (no local validation)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(JSON.stringify({ ok: false, error: 'Tool not available: nonexistent_tool' })),
    });

    const { client } = await setupClientServer(makeMockTools(), fetchSpy);
    const result = await client.callTool({ name: 'nonexistent_tool', arguments: {} });

    // Gateway is the source of truth — call goes through and returns error from gateway
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it('handles tool with empty parameters schema', async () => {
    const { client } = await setupClientServer(makeMockTools());
    const { tools } = await client.listTools();

    const screenshot = tools.find((t) => t.name === 'screenshot')!;
    expect(screenshot.inputSchema.type).toBe('object');
  });

  it('passes arguments correctly through to HTTP invoker', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } })
        ),
    });

    const { client } = await setupClientServer(makeMockTools(), fetchSpy);
    await client.callTool({ name: 'read', arguments: { path: '/home/user/file.txt' } });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tool).toBe('read');
    expect(body.args).toEqual({ path: '/home/user/file.txt' });
  });

  it('server reports correct name and version', async () => {
    const { client } = await setupClientServer(makeMockTools());
    const serverInfo = client.getServerVersion();

    expect(serverInfo?.name).toBe('remoteclaw');
    expect(serverInfo?.version).toBeDefined();
  });

  it('includes native tools alongside catalog tools when nativeHandler is provided', async () => {
    const client = {
      chat: vi.fn().mockResolvedValue({ response: 'hi from openclaw' }),
      health: vi.fn().mockResolvedValue({ status: 'ok' }),
    } as unknown as OpenClawClient;
    const nativeHandler = new NativeToolHandler(client, new TaskManager());

    const invoker = new ToolInvoker('http://localhost:18789', 'test-token');
    const server = createRemoteClawServer({
      tools: makeMockTools(),
      invoker,
      nativeHandler,
      extraTools: nativeToolDefinitions,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const { tools } = await mcpClient.listTools();
    const names = tools.map((t) => t.name);

    // 3 catalog tools + 6 native tools = 9
    expect(tools).toHaveLength(9);
    expect(names).toContain('web_search');
    expect(names).toContain('openclaw_chat');
    expect(names).toContain('openclaw_status');
    expect(names).toContain('openclaw_chat_async');
    expect(names).toContain('openclaw_task_list');
  });

  it('routes openclaw_chat to native handler, not tool invoker', async () => {
    const chatMock = vi.fn().mockResolvedValue({ response: 'native response' });
    const client = { chat: chatMock, health: vi.fn() } as unknown as OpenClawClient;
    const nativeHandler = new NativeToolHandler(client, new TaskManager());

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const invoker = new ToolInvoker('http://localhost:18789', 'test-token');
    const server = createRemoteClawServer({
      tools: makeMockTools(),
      invoker,
      nativeHandler,
      extraTools: nativeToolDefinitions,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const result = await mcpClient.callTool({
      name: 'openclaw_chat',
      arguments: { message: 'hello' },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'native response' }]);
    expect(chatMock).toHaveBeenCalledWith('hello', undefined);
    // fetch should NOT have been called — native tools bypass /tools/invoke
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dynamic tool list: supports function that returns tools', async () => {
    let callCount = 0;
    const toolsFn = () => {
      callCount++;
      const tools = makeMockTools();
      if (callCount > 1) {
        tools.push({
          name: 'new_tool',
          description: 'Dynamically added',
          parameters: { type: 'object' },
        });
      }
      return tools;
    };

    const { client } = await setupClientServer(toolsFn);

    const first = await client.listTools();
    expect(first.tools).toHaveLength(3);

    const second = await client.listTools();
    expect(second.tools).toHaveLength(4);
    expect(second.tools.map((t) => t.name)).toContain('new_tool');
  });
});
