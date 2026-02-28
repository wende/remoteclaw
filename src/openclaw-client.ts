/**
 * Lightweight OpenClaw gateway client for chat completions and health checks.
 * Ported from openclaw-mcp/src/openclaw/client.ts — stripped to essentials.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface OpenClawChatResponse {
  response: string;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenClawHealthResponse {
  status: 'ok' | 'error';
  message?: string;
}

interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenClawClient {
  private baseUrl: string;
  private gatewayToken: string | undefined;
  private timeoutMs: number;

  constructor(baseUrl: string, gatewayToken?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.gatewayToken = gatewayToken;
    this.timeoutMs = timeoutMs;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.gatewayToken) {
      headers['Authorization'] = `Bearer ${this.gatewayToken}`;
    }
    return headers;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { ...this.buildHeaders(), ...((options.headers as Record<string, string>) || {}) },
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE_BYTES) {
        throw new Error('Response exceeds maximum allowed size (10MB)');
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_SIZE_BYTES) {
        throw new Error('Response exceeds maximum allowed size (10MB)');
      }

      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request to OpenClaw timed out after ${this.timeoutMs}ms`);
      }
      if (error instanceof Error) throw error;
      throw new Error(`Failed to connect to OpenClaw at ${this.baseUrl}: Unknown error`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<OpenClawHealthResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: this.buildHeaders(),
        body: JSON.stringify({ model: 'health-check', messages: [], max_tokens: 1 }),
      });

      if (response.status >= 200 && response.status < 500) {
        return { status: 'ok', message: `Gateway is reachable and responding. HTTP ${response.status} is expected for the health-check probe.` };
      }
      return { status: 'error', message: `Gateway returned HTTP ${response.status} (server error)` };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request to OpenClaw timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(
        `Failed to connect to OpenClaw at ${this.baseUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async chat(message: string, _sessionId?: string): Promise<OpenClawChatResponse> {
    const completion = await this.request<OpenAIChatCompletionResponse>('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        messages: [{ role: 'user', content: message }],
        max_tokens: 4096,
      }),
    });

    return {
      response: completion.choices?.[0]?.message?.content ?? '',
      model: completion.model,
      usage: completion.usage,
    };
  }
}
