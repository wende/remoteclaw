import { describe, it, expect } from 'vitest';
import { mapToolResult, mapToolError, mapInvokeResponse } from '../result-mapper.js';
import type { AgentToolResult, ToolInvokeResponse } from '../types.js';

describe('mapToolResult', () => {
  it('maps text content from OpenClaw to MCP format', () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'hello world' }],
    };
    expect(mapToolResult(result)).toEqual({
      content: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('maps image content preserving data and mimeType', () => {
    const result: AgentToolResult = {
      content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
    };
    expect(mapToolResult(result)).toEqual({
      content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
    });
  });

  it('maps mixed content (text + image) array', () => {
    const result: AgentToolResult = {
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'img64', mimeType: 'image/jpeg' },
      ],
    };
    const mapped = mapToolResult(result);
    expect(mapped.content).toHaveLength(2);
    expect(mapped.content[0]).toEqual({ type: 'text', text: 'caption' });
    expect(mapped.content[1]).toEqual({ type: 'image', data: 'img64', mimeType: 'image/jpeg' });
  });

  it('strips details field from OpenClaw result', () => {
    const result: AgentToolResult = {
      content: [{ type: 'text', text: 'ok' }],
      details: { some: 'internal data' },
    };
    const mapped = mapToolResult(result);
    expect(mapped).not.toHaveProperty('details');
    expect(mapped).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('handles empty content array', () => {
    const result: AgentToolResult = { content: [] };
    expect(mapToolResult(result)).toEqual({ content: [] });
  });
});

describe('mapToolError', () => {
  it('maps Error to MCP error result with isError: true', () => {
    const error = new Error('something broke');
    const mapped = mapToolError(error);
    expect(mapped.isError).toBe(true);
    expect(mapped.content).toHaveLength(1);
    expect(mapped.content[0]).toEqual({ type: 'text', text: 'something broke' });
  });

  it('maps non-Error thrown value to generic error message', () => {
    const mapped = mapToolError('string error');
    expect(mapped.isError).toBe(true);
    expect(mapped.content[0]).toEqual({ type: 'text', text: 'Tool execution failed' });
  });
});

describe('mapInvokeResponse', () => {
  it('maps successful response with result', () => {
    const response: ToolInvokeResponse = {
      ok: true,
      result: {
        content: [{ type: 'text', text: 'done' }],
      },
    };
    expect(mapInvokeResponse(response)).toEqual({
      content: [{ type: 'text', text: 'done' }],
    });
  });

  it('maps HTTP error response { ok: false, error: "..." } to MCP error', () => {
    const response: ToolInvokeResponse = {
      ok: false,
      error: 'tool not found',
    };
    const mapped = mapInvokeResponse(response);
    expect(mapped.isError).toBe(true);
    expect(mapped.content[0]).toEqual({ type: 'text', text: 'tool not found' });
  });

  it('maps { ok: false } without error message to generic error', () => {
    const response: ToolInvokeResponse = { ok: false };
    const mapped = mapInvokeResponse(response);
    expect(mapped.isError).toBe(true);
    expect(mapped.content[0]).toEqual({ type: 'text', text: 'Tool invocation failed' });
  });
});
