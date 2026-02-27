import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NativeToolHandler, nativeToolDefinitions } from '../native-tools.js';
import { OpenClawClient } from '../openclaw-client.js';
import { TaskManager } from '../task-manager.js';
import type { McpToolResult } from '../types.js';

function textOf(result: McpToolResult, index = 0): string {
  const item = result.content[index];
  if (item.type !== 'text') throw new Error(`Expected text, got ${item.type}`);
  return item.text;
}

function createHandler(clientOverrides?: Partial<OpenClawClient>) {
  const client = {
    chat: vi.fn().mockResolvedValue({ response: 'hello from openclaw' }),
    health: vi.fn().mockResolvedValue({ status: 'ok', message: 'Gateway responding (HTTP 200)' }),
    ...clientOverrides,
  } as unknown as OpenClawClient;

  const taskManager = new TaskManager();
  const handler = new NativeToolHandler(client, taskManager);
  return { handler, client, taskManager };
}

describe('NativeToolHandler', () => {
  describe('tool definitions', () => {
    it('exports 6 native tool definitions', () => {
      expect(nativeToolDefinitions).toHaveLength(6);
      const names = nativeToolDefinitions.map((t) => t.name);
      expect(names).toEqual([
        'openclaw_chat',
        'openclaw_status',
        'openclaw_chat_async',
        'openclaw_task_status',
        'openclaw_task_list',
        'openclaw_task_cancel',
      ]);
    });

    it('all definitions have inputSchema with type: object', () => {
      for (const tool of nativeToolDefinitions) {
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('handles()', () => {
    it('returns true for native tool names', () => {
      const { handler } = createHandler();
      expect(handler.handles('openclaw_chat')).toBe(true);
      expect(handler.handles('openclaw_status')).toBe(true);
      expect(handler.handles('openclaw_chat_async')).toBe(true);
      expect(handler.handles('openclaw_task_status')).toBe(true);
      expect(handler.handles('openclaw_task_list')).toBe(true);
      expect(handler.handles('openclaw_task_cancel')).toBe(true);
    });

    it('returns false for catalog tool names', () => {
      const { handler } = createHandler();
      expect(handler.handles('web_search')).toBe(false);
      expect(handler.handles('read')).toBe(false);
    });
  });

  describe('openclaw_chat', () => {
    it('returns text response from client.chat()', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_chat', { message: 'hello' });

      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: 'hello from openclaw' }]);
    });

    it('passes session_id to client.chat()', async () => {
      const { handler, client } = createHandler();
      await handler.handle('openclaw_chat', { message: 'hi', session_id: 'sess-1' });

      expect(client.chat).toHaveBeenCalledWith('hi', 'sess-1');
    });

    it('returns error when message is missing', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_chat', {});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('message is required');
    });

    it('returns error when client.chat() throws', async () => {
      const { handler } = createHandler({
        chat: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const result = await handler.handle('openclaw_chat', { message: 'test' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('connection refused');
    });
  });

  describe('openclaw_status', () => {
    it('returns health response as JSON', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_status', {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(result));
      expect(parsed.status).toBe('ok');
    });

    it('returns error when health check fails', async () => {
      const { handler } = createHandler({
        health: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const result = await handler.handle('openclaw_status', {});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('timeout');
    });
  });

  describe('openclaw_chat_async', () => {
    it('creates a task and returns task_id', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_chat_async', { message: 'background task' });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(result));
      expect(parsed.task_id).toMatch(/^task_/);
      expect(parsed.status).toBe('pending');
    });

    it('validates message is required', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_chat_async', {});

      expect(result.isError).toBe(true);
    });

    it('validates priority is integer', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_chat_async', { message: 'hi', priority: 1.5 });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('priority must be an integer');
    });
  });

  describe('openclaw_task_status', () => {
    it('returns task details for existing task', async () => {
      const { handler, taskManager } = createHandler();
      const task = taskManager.create({ type: 'chat', input: { message: 'test' } });

      const result = await handler.handle('openclaw_task_status', { task_id: task.id });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(result));
      expect(parsed.task_id).toBe(task.id);
      expect(parsed.status).toBe('pending');
    });

    it('returns error for non-existent task', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_task_status', { task_id: 'nope' });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Task not found');
    });

    it('returns error when task_id is missing', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_task_status', {});

      expect(result.isError).toBe(true);
    });
  });

  describe('openclaw_task_list', () => {
    it('lists all tasks with stats', async () => {
      const { handler, taskManager } = createHandler();
      taskManager.create({ type: 'chat', input: { message: 'a' } });
      taskManager.create({ type: 'chat', input: { message: 'b' } });

      const result = await handler.handle('openclaw_task_list', {});

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(result));
      expect(parsed.tasks).toHaveLength(2);
      expect(parsed.stats.total).toBe(2);
    });

    it('filters by status', async () => {
      const { handler, taskManager } = createHandler();
      const task = taskManager.create({ type: 'chat', input: { message: 'a' } });
      taskManager.create({ type: 'chat', input: { message: 'b' } });
      taskManager.updateStatus(task.id, 'completed', 'done');

      const result = await handler.handle('openclaw_task_list', { status: 'pending' });

      const parsed = JSON.parse(textOf(result));
      expect(parsed.tasks).toHaveLength(1);
    });

    it('rejects invalid status', async () => {
      const { handler } = createHandler();
      const result = await handler.handle('openclaw_task_list', { status: 'invalid' });

      expect(result.isError).toBe(true);
    });
  });

  describe('openclaw_task_cancel', () => {
    it('cancels a pending task', async () => {
      const { handler, taskManager } = createHandler();
      const task = taskManager.create({ type: 'chat', input: { message: 'cancel me' } });

      const result = await handler.handle('openclaw_task_cancel', { task_id: task.id });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(result));
      expect(parsed.status).toBe('cancelled');
    });

    it('rejects cancellation of non-pending task', async () => {
      const { handler, taskManager } = createHandler();
      const task = taskManager.create({ type: 'chat', input: { message: 'x' } });
      taskManager.updateStatus(task.id, 'running');

      const result = await handler.handle('openclaw_task_cancel', { task_id: task.id });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Cannot cancel');
    });
  });
});
