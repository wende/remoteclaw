import type { ToolInvokeResponse } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class ToolInvoker {
  private baseUrl: string;
  private token: string | undefined;
  private sessionKey: string;
  private timeoutMs: number;

  constructor(
    baseUrl: string,
    token?: string,
    sessionKey: string = 'main',
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.sessionKey = sessionKey;
    this.timeoutMs = timeoutMs;
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<ToolInvokeResponse> {
    const url = `${this.baseUrl}/tools/invoke`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tool: toolName,
          args,
          sessionKey: this.sessionKey,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`
        );
      }

      const data: ToolInvokeResponse = JSON.parse(await response.text());
      return data;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
