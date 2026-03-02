import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { AgentTool, McpTool } from './types.js';

export function agentToolsToMcpTools(tools: AgentTool[]): McpTool[] {
  return tools.map((tool) => {
    const { type: _type, ...rest } = tool.parameters;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        ...rest,
        type: 'object' as const,
      },
    };
  });
}

const MARKER_FILE = join('src', 'agents', 'pi-tools.ts');

function hasOpenClawSource(dir: string): boolean {
  return existsSync(join(dir, MARKER_FILE)) || existsSync(join(dir, MARKER_FILE.replace('.ts', '.js')));
}

/**
 * Auto-detect the OpenClaw source root directory.
 * Tries (in order): plugin config > env var > process.argv > installed package > common dev paths.
 */
export function findOpenClawRoot(pluginConfig: Record<string, unknown>): string | null {
  // 1. Explicit config
  if (typeof pluginConfig.openclawRoot === 'string' && pluginConfig.openclawRoot) {
    return pluginConfig.openclawRoot;
  }

  // 2. Environment variable
  if (process.env.OPENCLAW_ROOT) {
    return process.env.OPENCLAW_ROOT;
  }

  // 3. Auto-detect from process.argv — when the gateway runs from source,
  //    argv contains paths like {root}/src/cli/main.ts
  for (const arg of process.argv) {
    const srcMatch = arg.match(/^(.+?)\/src\//);
    if (srcMatch) {
      const candidate = srcMatch[1];
      if (hasOpenClawSource(candidate)) return candidate;
    }
  }

  // 4. Try to find the installed package root (works for npm link or dev installs)
  try {
    const req = createRequire(import.meta.url);
    const pkgRoot = dirname(req.resolve('openclaw/package.json'));
    if (hasOpenClawSource(pkgRoot)) return pkgRoot;
  } catch {}

  // 5. Check well-known dev paths (sibling to this plugin's project)
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const candidates = [
      join(homeDir, 'projects', 'openclaw'),
      join(homeDir, 'src', 'openclaw'),
      join(homeDir, 'dev', 'openclaw'),
    ];
    for (const candidate of candidates) {
      if (hasOpenClawSource(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Find the installed openclaw package's dist directory.
 * Works on deployed machines where only the bundled dist exists.
 */
export function findOpenClawDist(): string | null {
  // 1. Resolve from process.argv — gateway entry point is inside dist/
  for (const arg of process.argv) {
    const distMatch = arg.match(/^(.+?\/node_modules\/openclaw\/dist)\//);
    if (distMatch && existsSync(distMatch[1])) return distMatch[1];
  }

  // 2. Walk up from process.argv[1] looking for node_modules/openclaw/dist
  if (process.argv[1]) {
    let dir = dirname(process.argv[1]);
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, 'node_modules', 'openclaw', 'dist');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 3. Well-known global install paths
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    // fnm
    const fnmBase = join(homeDir, '.local', 'share', 'fnm', 'node-versions');
    if (existsSync(fnmBase)) {
      try {
        for (const ver of readdirSync(fnmBase)) {
          const candidate = join(fnmBase, ver, 'installation', 'lib', 'node_modules', 'openclaw', 'dist');
          if (existsSync(candidate)) return candidate;
        }
      } catch {}
    }
    // nvm
    const nvmBase = join(homeDir, '.nvm', 'versions', 'node');
    if (existsSync(nvmBase)) {
      try {
        for (const ver of readdirSync(nvmBase)) {
          const candidate = join(nvmBase, ver, 'lib', 'node_modules', 'openclaw', 'dist');
          if (existsSync(candidate)) return candidate;
        }
      } catch {}
    }
  }

  return null;
}

/**
 * Find createOpenClawTools in bundled dist chunks.
 * The bundler (tsdown) exports it with a mangled name; we scan for the chunk
 * that re-exports it and identify the function by calling it with { config: {} }.
 */
async function importCreateOpenClawCodingToolsFromDist(distDir: string): Promise<((...args: any[]) => any) | null> {
  const files = readdirSync(distDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const content = readFileSync(join(distDir, file), 'utf-8');
    if (!content.includes('createOpenClawCodingTools')) continue;

    let mod: any;
    try {
      mod = await import(join(distDir, file));
    } catch {
      continue;
    }

    for (const [, val] of Object.entries(mod)) {
      if (typeof val !== 'function') continue;
      try {
        const result = (val as any)({ config: {} });
        if (Array.isArray(result) && result.length > 0 && result[0]?.name && result[0]?.execute) {
          return val as any;
        }
      } catch {
        // not this function
      }
    }
  }
  return null;
}

/**
 * Discover plugin-registered tools from the gateway's active plugin registry.
 * The gateway stores the registry on globalThis via Symbol.for("openclaw.pluginRegistryState").
 * Since RemoteClaw runs in the same process, we read it directly — no imports needed.
 */
export function discoverPluginToolsFromRegistry(opts: {
  config?: Record<string, unknown>;
}): AgentTool[] {
  const REGISTRY_STATE = Symbol.for('openclaw.pluginRegistryState');
  const registryState = (globalThis as any)[REGISTRY_STATE] as
    | { registry: { tools?: Array<{ factory: (ctx: any) => any; names?: string[]; pluginId?: string }> } | null }
    | undefined;

  const registry = registryState?.registry;
  if (!registry || !Array.isArray(registry.tools) || registry.tools.length === 0) {
    return [];
  }

  const tools: AgentTool[] = [];
  for (const entry of registry.tools) {
    try {
      const result = entry.factory({ config: opts.config ?? {} });
      const items = Array.isArray(result) ? result : [result];
      for (const t of items) {
        if (t && t.name) {
          tools.push({
            name: String(t.name),
            description: String(t.description ?? ''),
            parameters: t.parameters ?? { type: 'object' },
          });
        }
      }
    } catch {
      // Factory failed — skip this plugin's tools
    }
  }

  return tools;
}

/**
 * Dynamically discover all tools by importing createOpenClawTools from the OpenClaw source.
 * This works because the RemoteClaw plugin runs inside the gateway process.
 */
export async function discoverToolsDynamic(opts: {
  pluginConfig: Record<string, unknown>;
  loadConfig?: () => Record<string, unknown>;
}): Promise<AgentTool[]> {
  const root = findOpenClawRoot(opts.pluginConfig);
  if (!root) {
    throw new Error(
      'Cannot find OpenClaw source root. Set openclawRoot in plugin config or OPENCLAW_ROOT env var.'
    );
  }

  // Dynamic import — works because we're in the gateway process and jiti handles resolution.
  const modulePath = join(root, 'src', 'agents', 'pi-tools.js');
  let mod: any;
  try {
    mod = await import(modulePath);
  } catch {
    mod = await import(modulePath.replace(/\.js$/, '.ts'));
  }

  const createOpenClawCodingTools = mod.createOpenClawCodingTools ?? mod.default?.createOpenClawCodingTools;
  if (typeof createOpenClawCodingTools !== 'function') {
    throw new Error(`createOpenClawCodingTools not found in ${modulePath}`);
  }

  // Use the runtime's loadConfig if available, otherwise import it from the source tree.
  let config: Record<string, unknown>;
  if (opts.loadConfig) {
    config = opts.loadConfig();
  } else {
    const configModPath = join(root, 'src', 'config', 'config.js');
    let configMod: any;
    try {
      configMod = await import(configModPath);
    } catch {
      configMod = await import(configModPath.replace(/\.js$/, '.ts'));
    }
    config = configMod.loadConfig();
  }

  const allTools = createOpenClawCodingTools({ config });

  // Filter out tools implemented natively in RemoteClaw (don't capture their execute methods)
  const nativeSystemTools = new Set(['exec', 'process', 'read', 'canvas']);

  return allTools
    .filter((t: any) => !nativeSystemTools.has(t.name))
    .map((t: any) => ({
      name: String(t.name ?? ''),
      description: String(t.description ?? ''),
      parameters: t.parameters ?? { type: 'object' },
      execute: typeof t.execute === 'function' ? t.execute : undefined,
    }));
}
