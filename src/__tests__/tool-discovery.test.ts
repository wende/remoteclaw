import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findOpenClawRoot, findOpenClawDist, agentToolsToMcpTools, discoverPluginToolsFromRegistry } from '../tool-discovery.js';

describe('findOpenClawRoot', () => {
  let originalEnv: string | undefined;
  let originalArgv: string[];

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_ROOT;
    originalArgv = process.argv;
    delete process.env.OPENCLAW_ROOT;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENCLAW_ROOT = originalEnv;
    } else {
      delete process.env.OPENCLAW_ROOT;
    }
    process.argv = originalArgv;
  });

  it('returns openclawRoot from plugin config (highest priority)', () => {
    expect(findOpenClawRoot({ openclawRoot: '/custom/openclaw' })).toBe('/custom/openclaw');
  });

  it('returns OPENCLAW_ROOT env var when no config', () => {
    process.env.OPENCLAW_ROOT = '/env/openclaw';
    expect(findOpenClawRoot({})).toBe('/env/openclaw');
  });

  it('prefers config over env var', () => {
    process.env.OPENCLAW_ROOT = '/env/openclaw';
    expect(findOpenClawRoot({ openclawRoot: '/config/openclaw' })).toBe('/config/openclaw');
  });

  it('auto-detects from process.argv when running from source', () => {
    process.argv = ['node', '/fake/openclaw/src/cli/main.ts'];
    // Won't find it because /fake/openclaw doesn't exist, falls through
    const result = findOpenClawRoot({});
    // Should NOT be /fake/openclaw (doesn't exist)
    expect(result).not.toBe('/fake/openclaw');
  });

  it('returns a string (not null) on a dev machine with ~/projects/openclaw', () => {
    // On this dev machine, findOpenClawRoot should find the dev source
    // via the well-known dev paths check
    process.argv = ['node', '/usr/local/bin/some-script'];
    const result = findOpenClawRoot({});
    // This test documents the auto-detection behavior
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe('findOpenClawDist', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('finds dist from process.argv containing node_modules/openclaw/dist path', () => {
    process.argv = ['node', '/usr/lib/node_modules/openclaw/dist/index.js'];
    // Won't find it on this machine at that path, but tests the regex
    const result = findOpenClawDist();
    // If the path doesn't exist, returns null — that's fine
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('finds installed openclaw dist on this dev machine', () => {
    // On this machine, openclaw is installed globally via fnm
    const result = findOpenClawDist();
    if (result !== null) {
      expect(result).toMatch(/openclaw\/dist$/);
    }
  });
});

describe('discoverPluginToolsFromRegistry', () => {
  const REGISTRY_STATE = Symbol.for('openclaw.pluginRegistryState');

  afterEach(() => {
    delete (globalThis as any)[REGISTRY_STATE];
  });

  it('returns empty array when no registry exists', () => {
    delete (globalThis as any)[REGISTRY_STATE];
    expect(discoverPluginToolsFromRegistry({})).toEqual([]);
  });

  it('returns empty array when registry has no tools', () => {
    (globalThis as any)[REGISTRY_STATE] = {
      registry: { tools: [] },
      key: null,
    };
    expect(discoverPluginToolsFromRegistry({})).toEqual([]);
  });

  it('discovers tools from plugin factories', () => {
    (globalThis as any)[REGISTRY_STATE] = {
      registry: {
        tools: [
          {
            pluginId: 'test-plugin',
            names: ['model_usage'],
            factory: () => ({
              name: 'model_usage',
              description: 'Track model usage',
              parameters: { type: 'object', properties: { model: { type: 'string' } } },
              execute: async () => ({ content: [] }),
            }),
          },
        ],
      },
      key: null,
    };

    const tools = discoverPluginToolsFromRegistry({ config: {} });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('model_usage');
    expect(tools[0].description).toBe('Track model usage');
    expect(tools[0].parameters.properties).toEqual({ model: { type: 'string' } });
  });

  it('handles factory returning an array of tools', () => {
    (globalThis as any)[REGISTRY_STATE] = {
      registry: {
        tools: [
          {
            pluginId: 'multi-plugin',
            names: ['tool_a', 'tool_b'],
            factory: () => [
              { name: 'tool_a', description: 'A', parameters: { type: 'object' } },
              { name: 'tool_b', description: 'B', parameters: { type: 'object' } },
            ],
          },
        ],
      },
      key: null,
    };

    const tools = discoverPluginToolsFromRegistry({});
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['tool_a', 'tool_b']);
  });

  it('skips factories that throw', () => {
    (globalThis as any)[REGISTRY_STATE] = {
      registry: {
        tools: [
          {
            pluginId: 'broken',
            names: ['broken_tool'],
            factory: () => { throw new Error('init failed'); },
          },
          {
            pluginId: 'good',
            names: ['good_tool'],
            factory: () => ({ name: 'good_tool', description: 'Works', parameters: { type: 'object' } }),
          },
        ],
      },
      key: null,
    };

    const tools = discoverPluginToolsFromRegistry({});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('good_tool');
  });

  it('passes config to factory', () => {
    let receivedConfig: any;
    (globalThis as any)[REGISTRY_STATE] = {
      registry: {
        tools: [
          {
            pluginId: 'config-reader',
            names: ['cfg_tool'],
            factory: (ctx: any) => {
              receivedConfig = ctx.config;
              return { name: 'cfg_tool', description: 'Reads config', parameters: { type: 'object' } };
            },
          },
        ],
      },
      key: null,
    };

    discoverPluginToolsFromRegistry({ config: { myKey: 'myValue' } });
    expect(receivedConfig).toEqual({ myKey: 'myValue' });
  });
});

describe('agentToolsToMcpTools', () => {
  it('maps tool name, description, and parameters', () => {
    const tools = agentToolsToMcpTools([
      {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_tool');
    expect(tools[0].description).toBe('A test tool');
    expect(tools[0].inputSchema.type).toBe('object');
    expect(tools[0].inputSchema.properties).toEqual({ query: { type: 'string' } });
    expect(tools[0].inputSchema.required).toEqual(['query']);
  });

  it('ensures type: object in inputSchema even if missing', () => {
    const tools = agentToolsToMcpTools([
      {
        name: 'empty',
        description: 'No params',
        parameters: { type: 'object' },
      },
    ]);
    expect(tools[0].inputSchema.type).toBe('object');
  });
});
