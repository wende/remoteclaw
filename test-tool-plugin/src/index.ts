/**
 * Test plugin that registers a simple "echo" tool.
 * Used to verify custom tool registration works end-to-end through RemoteClaw.
 */

export function register(api: any) {
  api.registerTool({
    name: 'echo',
    description: 'Echo back the input message. Used for testing tool invocation.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to echo back',
        },
      },
      required: ['message'],
    },
    async execute(_callId: string, args: Record<string, unknown>) {
      const message = args.message as string;
      return {
        content: [
          { type: 'text', text: `Echo: ${message}` },
        ],
      };
    },
  });
}
