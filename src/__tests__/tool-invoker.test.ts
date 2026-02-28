import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolInvoker } from '../tool-invoker.js';

describe('ToolInvoker', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends POST to /tools/invoke with correct URL', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, result: { content: [] } })),
    });

    const invoker = new ToolInvoker('http://localhost:18789');
    await invoker.invoke('web_search', { query: 'hello' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:18789/tools/invoke');
  });

  it('includes Authorization Bearer header when token configured', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, result: { content: [] } })),
    });

    const invoker = new ToolInvoker('http://localhost:18789', 'my-secret-token');
    await invoker.invoke('read', {});

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers['Authorization']).toBe('Bearer my-secret-token');
  });

  it('omits Authorization header when no token', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, result: { content: [] } })),
    });

    const invoker = new ToolInvoker('http://localhost:18789');
    await invoker.invoke('read', {});

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  it('sends tool name, args, sessionKey in body', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, result: { content: [] } })),
    });

    const invoker = new ToolInvoker('http://localhost:18789', undefined, 'session-42');
    await invoker.invoke('exec', { command: 'ls -la' });

    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.tool).toBe('exec');
    expect(body.args).toEqual({ command: 'ls -la' });
    expect(body.sessionKey).toBe('session-42');
  });

  it('returns parsed result on 200 { ok: true }', async () => {
    const responseData = {
      ok: true,
      result: { content: [{ type: 'text', text: 'output' }] },
    };
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(responseData)),
    });

    const invoker = new ToolInvoker('http://localhost:18789');
    const result = await invoker.invoke('read', { path: '/tmp/test' });

    expect(result).toEqual(responseData);
  });

  it('throws on non-ok HTTP status (500)', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('server error'),
    });

    const invoker = new ToolInvoker('http://localhost:18789');
    await expect(invoker.invoke('read', {})).rejects.toThrow(/500/);
  });

  it('returns { ok: false } response without throwing', async () => {
    const responseData = { ok: false, error: 'tool not found' };
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(responseData)),
    });

    const invoker = new ToolInvoker('http://localhost:18789');
    const result = await invoker.invoke('nonexistent', {});
    expect(result).toEqual(responseData);
  });

  it('throws on network failure (fetch rejects)', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const invoker = new ToolInvoker('http://localhost:18789');
    await expect(invoker.invoke('read', {})).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws on timeout (AbortError)', async () => {
    fetchSpy.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => {
            const err = new DOMException('The operation was aborted', 'AbortError');
            reject(err);
          }, 50);
        })
    );

    const invoker = new ToolInvoker('http://localhost:18789', undefined, 'main', 10);
    await expect(invoker.invoke('read', {})).rejects.toThrow(/timed out/);
  });

  describe('listTools()', () => {
    it('returns tools from gateway GET /tools', async () => {
      const tools = [
        { name: 'read', description: 'Read a file', parameters: [] },
        { name: 'write', description: 'Write a file', parameters: [] },
      ];
      fetchSpy.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(tools)),
      });

      const invoker = new ToolInvoker('http://localhost:18789');
      const result = await invoker.listTools();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:18789/tools');
      expect(options.method).toBe('GET');
      expect(result).toEqual(tools);
    });

    it('handles { tools: [...] } wrapper format', async () => {
      const tools = [{ name: 'exec', description: 'Execute', parameters: [] }];
      fetchSpy.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ tools })),
      });

      const invoker = new ToolInvoker('http://localhost:18789');
      const result = await invoker.listTools();

      expect(result).toEqual(tools);
    });

    it('returns empty array on 404', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const invoker = new ToolInvoker('http://localhost:18789');
      const result = await invoker.listTools();

      expect(result).toEqual([]);
    });

    it('returns empty array on network error', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

      const invoker = new ToolInvoker('http://localhost:18789');
      const result = await invoker.listTools();

      expect(result).toEqual([]);
    });

    it('includes auth header when token configured', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([])),
      });

      const invoker = new ToolInvoker('http://localhost:18789', 'secret-token');
      await invoker.listTools();

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer secret-token');
    });

    it('omits auth header when no token', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(JSON.stringify([])),
      });

      const invoker = new ToolInvoker('http://localhost:18789');
      await invoker.listTools();

      const [, options] = fetchSpy.mock.calls[0];
      expect(options.headers).not.toHaveProperty('Authorization');
    });
  });

  it('uses configurable gateway URL and session key', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ ok: true, result: { content: [] } })),
    });

    const invoker = new ToolInvoker('http://custom:9999', 'tok', 'my-session');
    await invoker.invoke('write', { path: '/tmp/x', content: 'hi' });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://custom:9999/tools/invoke');
    const body = JSON.parse(options.body);
    expect(body.sessionKey).toBe('my-session');
  });
});
