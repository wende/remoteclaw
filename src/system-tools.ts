/**
 * System tools: exec, process, read
 * These are native implementations that don't rely on the gateway.
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpTool, McpToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const execTool: McpTool = {
  name: 'exec',
  description: 'Execute shell commands',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (optional)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (optional, default 30000)',
      },
    },
    required: ['command'],
  },
};

export const processListTool: McpTool = {
  name: 'process',
  description: 'List processes',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list'],
        description: 'Action to perform',
      },
    },
    required: ['action'],
  },
};

export const readTool: McpTool = {
  name: 'read',
  description: 'Read files from the filesystem',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file or directory',
      },
      encoding: {
        type: 'string',
        description: 'File encoding (default: utf-8)',
      },
    },
    required: ['path'],
  },
};

export const systemToolDefinitions: McpTool[] = [execTool, processListTool, readTool];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// Handler class
// ---------------------------------------------------------------------------

export class SystemToolHandler {
  private nativeNames: Set<string>;

  constructor() {
    this.nativeNames = new Set(systemToolDefinitions.map((t) => t.name));
  }

  handles(toolName: string): boolean {
    return this.nativeNames.has(toolName);
  }

  async handle(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    switch (toolName) {
      case 'exec':
        return this.handleExec(args);
      case 'process':
        return this.handleProcess(args);
      case 'read':
        return this.handleRead(args);
      default:
        return errorResult(`Unknown system tool: ${toolName}`);
    }
  }

  private async handleExec(args: Record<string, unknown>): Promise<McpToolResult> {
    const command = args.command;
    if (typeof command !== 'string' || command.trim().length === 0) {
      return errorResult('command is required and must be a non-empty string');
    }

    const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();
    const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;

    try {
      const output = execSync(command, {
        cwd,
        timeout,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      return textResult(output);
    } catch (error: any) {
      const message = error.stderr ? String(error.stderr) : String(error.message);
      return errorResult(message);
    }
  }

  private async handleProcess(args: Record<string, unknown>): Promise<McpToolResult> {
    const action = args.action;

    if (action === 'list') {
      try {
        const output = execSync('ps aux', { encoding: 'utf-8' });
        return textResult(output);
      } catch (error: any) {
        return errorResult(`Failed to list processes: ${error.message}`);
      }
    }

    return errorResult(`Unknown action: ${action}`);
  }

  private async handleRead(args: Record<string, unknown>): Promise<McpToolResult> {
    const path = args.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      return errorResult('path is required and must be a non-empty string');
    }

    const encoding = typeof args.encoding === 'string' ? args.encoding : 'utf-8';

    try {
      // Check if it's a file or directory
      const stat = statSync(path);

      if (stat.isDirectory()) {
        // List directory contents
        try {
          const files = readdirSync(path);
          const details = files.map((f) => {
            const fullPath = join(path, f);
            try {
              const s = statSync(fullPath);
              return `${s.isDirectory() ? '[DIR]' : '[FILE]'} ${f} (${s.size} bytes)`;
            } catch {
              return `[?] ${f}`;
            }
          });
          return textResult(`Directory listing of ${path}:\n${details.join('\n')}`);
        } catch (error: any) {
          return errorResult(`Failed to list directory: ${error.message}`);
        }
      } else {
        // Read file
        try {
          const content = readFileSync(path, encoding as BufferEncoding);
          return textResult(content);
        } catch (error: any) {
          return errorResult(`Failed to read file: ${error.message}`);
        }
      }
    } catch (error: any) {
      return errorResult(`Failed to access path: ${error.message}`);
    }
  }
}
