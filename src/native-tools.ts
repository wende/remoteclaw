/**
 * Native MCP tools ported from openclaw-mcp.
 *
 * These tools talk to the gateway's /v1/chat/completions endpoint (not /tools/invoke).
 * They provide: sync chat, health status, async chat with task management.
 */

import type { McpTool, McpToolResult } from './types.js';
import type { OpenClawClient } from './openclaw-client.js';
import { TaskManager, type Task, type TaskStatus } from './task-manager.js';
import type { SystemToolHandler } from './system-tools.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const openclawChatTool: McpTool = {
  name: 'openclaw_chat',
  description: 'Send a message to OpenClaw and get a response',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to send to OpenClaw' },
      session_id: { type: 'string', description: 'Optional session ID for conversation context' },
    },
    required: ['message'],
  },
};

const openclawStatusTool: McpTool = {
  name: 'openclaw_status',
  description: 'Get OpenClaw gateway status and health information',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

const openclawChatAsyncTool: McpTool = {
  name: 'openclaw_chat_async',
  description:
    'Send a message to OpenClaw asynchronously. Returns a task_id immediately that can be polled for results. Use this for potentially long-running conversations.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to send to OpenClaw' },
      session_id: { type: 'string', description: 'Optional session ID for conversation context' },
      priority: {
        type: 'number',
        description: 'Task priority (higher = processed first). Default: 0',
      },
    },
    required: ['message'],
  },
};

const openclawTaskStatusTool: McpTool = {
  name: 'openclaw_task_status',
  description: 'Check the status of an async task. Returns status, and result if completed.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID returned from openclaw_chat_async' },
    },
    required: ['task_id'],
  },
};

const openclawTaskListTool: McpTool = {
  name: 'openclaw_task_list',
  description: 'List all tasks. Optionally filter by status or session.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
        description: 'Filter by task status',
      },
      session_id: { type: 'string', description: 'Filter by session ID' },
    },
  },
};

const openclawTaskCancelTool: McpTool = {
  name: 'openclaw_task_cancel',
  description: "Cancel a pending task. Only works for tasks that haven't started yet.",
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'The task ID to cancel' },
    },
    required: ['task_id'],
  },
};

export const nativeToolDefinitions: McpTool[] = [
  openclawChatTool,
  openclawStatusTool,
  openclawChatAsyncTool,
  openclawTaskStatusTool,
  openclawTaskListTool,
  openclawTaskCancelTool,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const VALID_TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];

// ---------------------------------------------------------------------------
// Handler class
// ---------------------------------------------------------------------------

export class NativeToolHandler {
  private client: OpenClawClient;
  private taskManager: TaskManager;
  private processorRunning = false;
  private nativeNames: Set<string>;
  private systemHandler?: SystemToolHandler;

  constructor(client: OpenClawClient, taskManager: TaskManager, systemHandler?: SystemToolHandler) {
    this.client = client;
    this.taskManager = taskManager;
    this.systemHandler = systemHandler;
    this.nativeNames = new Set(nativeToolDefinitions.map((t) => t.name));
  }

  handles(toolName: string): boolean {
    if (this.nativeNames.has(toolName)) return true;
    if (this.systemHandler?.handles(toolName)) return true;
    return false;
  }

  async handle(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    // Try system tools first
    if (this.systemHandler?.handles(toolName)) {
      return this.systemHandler.handle(toolName, args);
    }

    switch (toolName) {
      case 'openclaw_chat':
        return this.handleChat(args);
      case 'openclaw_status':
        return this.handleStatus();
      case 'openclaw_chat_async':
        return this.handleChatAsync(args);
      case 'openclaw_task_status':
        return this.handleTaskStatus(args);
      case 'openclaw_task_list':
        return this.handleTaskList(args);
      case 'openclaw_task_cancel':
        return this.handleTaskCancel(args);
      default:
        return errorResult(`Unknown native tool: ${toolName}`);
    }
  }

  stop(): void {
    this.processorRunning = false;
    this.taskManager.dispose();
  }

  // -- individual handlers --------------------------------------------------

  private async handleChat(args: Record<string, unknown>): Promise<McpToolResult> {
    const message = args.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return errorResult('message is required and must be a non-empty string');
    }
    const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;

    try {
      const response = await this.client.chat(message, sessionId);
      return textResult(response.response);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'Failed to chat with OpenClaw');
    }
  }

  private async handleStatus(): Promise<McpToolResult> {
    try {
      const response = await this.client.health();
      return textResult(JSON.stringify(response, null, 2));
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : 'Failed to get status from OpenClaw'
      );
    }
  }

  private async handleChatAsync(args: Record<string, unknown>): Promise<McpToolResult> {
    const message = args.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return errorResult('message is required and must be a non-empty string');
    }
    const sessionId = typeof args.session_id === 'string' ? args.session_id : undefined;
    let priority = 0;
    if (args.priority !== undefined) {
      if (typeof args.priority !== 'number' || !Number.isInteger(args.priority)) {
        return errorResult('priority must be an integer');
      }
      priority = args.priority;
    }

    this.ensureProcessorRunning();

    const task = this.taskManager.create({
      type: 'chat',
      input: { message, session_id: sessionId },
      sessionId,
      priority,
    });

    return textResult(
      JSON.stringify(
        { task_id: task.id, status: task.status, message: 'Task queued. Use openclaw_task_status to check progress.' },
        null,
        2
      )
    );
  }

  private async handleTaskStatus(args: Record<string, unknown>): Promise<McpToolResult> {
    const taskId = args.task_id;
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      return errorResult('task_id is required');
    }

    const task = this.taskManager.get(taskId);
    if (!task) return errorResult(`Task not found: ${taskId}`);

    const response: Record<string, unknown> = {
      task_id: task.id,
      type: task.type,
      status: task.status,
      created_at: task.createdAt.toISOString(),
    };
    if (task.startedAt) response.started_at = task.startedAt.toISOString();
    if (task.completedAt) response.completed_at = task.completedAt.toISOString();
    if (task.status === 'completed' && task.result) response.result = task.result;
    if (task.status === 'failed' && task.error) response.error = task.error;

    return textResult(JSON.stringify(response, null, 2));
  }

  private async handleTaskList(args: Record<string, unknown>): Promise<McpToolResult> {
    let status: TaskStatus | undefined;
    if (args.status !== undefined) {
      if (typeof args.status !== 'string' || !VALID_TASK_STATUSES.includes(args.status as TaskStatus)) {
        return errorResult(`status must be one of: ${VALID_TASK_STATUSES.join(', ')}`);
      }
      status = args.status as TaskStatus;
    }

    let sessionId: string | undefined;
    if (typeof args.session_id === 'string') sessionId = args.session_id;

    const tasks = this.taskManager.list({ status, sessionId });
    const stats = this.taskManager.stats();

    const taskList = tasks.map((t) => ({
      task_id: t.id,
      type: t.type,
      status: t.status,
      priority: t.priority,
      created_at: t.createdAt.toISOString(),
      has_result: t.status === 'completed' && !!t.result,
    }));

    return textResult(JSON.stringify({ stats, tasks: taskList }, null, 2));
  }

  private async handleTaskCancel(args: Record<string, unknown>): Promise<McpToolResult> {
    const taskId = args.task_id;
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      return errorResult('task_id is required');
    }

    const task = this.taskManager.get(taskId);
    if (!task) return errorResult(`Task not found: ${taskId}`);

    if (task.status !== 'pending') {
      return errorResult(
        `Cannot cancel task with status: ${task.status}. Only pending tasks can be cancelled.`
      );
    }

    const cancelled = this.taskManager.cancel(taskId);
    if (!cancelled) return errorResult('Failed to cancel task');

    return textResult(
      JSON.stringify({ task_id: taskId, status: 'cancelled', message: 'Task cancelled successfully' }, null, 2)
    );
  }

  // -- background task processor --------------------------------------------

  private ensureProcessorRunning(): void {
    if (this.processorRunning) return;
    this.processorRunning = true;
    this.runProcessor().catch(() => {
      this.processorRunning = false;
    });
  }

  private async runProcessor(): Promise<void> {
    while (this.processorRunning) {
      const task = this.taskManager.getNextPending();
      if (task) {
        await this.processTask(task);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async processTask(task: Task): Promise<void> {
    this.taskManager.updateStatus(task.id, 'running');
    try {
      if (task.type === 'chat') {
        const input = task.input as { message: string; session_id?: string };
        const response = await this.client.chat(input.message, input.session_id);
        this.taskManager.updateStatus(task.id, 'completed', response.response);
      } else {
        this.taskManager.updateStatus(task.id, 'failed', undefined, 'Unknown task type');
      }
    } catch (error) {
      this.taskManager.updateStatus(
        task.id,
        'failed',
        undefined,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }
}
