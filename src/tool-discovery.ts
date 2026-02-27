import { existsSync, readdirSync } from 'node:fs';
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

const MARKER_FILE = join('src', 'agents', 'openclaw-tools.ts');

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
  const modulePath = join(root, 'src', 'agents', 'openclaw-tools.js');
  let mod: any;
  try {
    mod = await import(modulePath);
  } catch {
    mod = await import(modulePath.replace(/\.js$/, '.ts'));
  }

  const createOpenClawTools = mod.createOpenClawTools ?? mod.default?.createOpenClawTools;
  if (typeof createOpenClawTools !== 'function') {
    throw new Error(`createOpenClawTools not found in ${modulePath}`);
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

  const allTools = createOpenClawTools({ config });

  return allTools.map((t: any) => ({
    name: String(t.name ?? ''),
    description: String(t.description ?? ''),
    parameters: t.parameters ?? { type: 'object' },
  }));
}
