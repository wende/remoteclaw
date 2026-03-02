#!/usr/bin/env node
/**
 * Generates a static tool catalog (JSON) from the OpenClaw source tree.
 * Uses jiti (from the installed OpenClaw package) for TypeScript loading.
 *
 * Usage:  node scripts/generate-catalog.cjs [openclaw-src-root]
 * Default: ~/projects/openclaw
 */
'use strict';

process.on('uncaughtException', (e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

const fs = require('node:fs');
const path = require('node:path');

const openclawRoot = path.resolve(process.argv[2] || path.join(process.env.HOME, 'projects/openclaw'));
const toolsFile = path.join(openclawRoot, 'src', 'agents', 'pi-tools.ts');

if (!fs.existsSync(toolsFile)) {
  console.error(`Cannot find ${toolsFile}`);
  process.exit(1);
}

// Use locally-installed jiti (more reliable than extracting from openclaw's bundled deps)
const createJiti = require('jiti');
const jiti = createJiti(__filename, {
  interopDefault: true,
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'],
});

try {
  const mod = jiti(toolsFile);
  const createOpenClawCodingTools = mod.createOpenClawCodingTools || mod.default?.createOpenClawCodingTools;

  if (typeof createOpenClawCodingTools !== 'function') {
    console.error('createOpenClawCodingTools not found. Exports:', Object.keys(mod).join(', '));
    process.exit(1);
  }

  const tools = createOpenClawCodingTools({});
  const catalog = tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: t.parameters || { type: 'object', properties: {} },
  }));

  const outPath = path.join(__dirname, '..', 'src', 'tool-catalog.json');
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Wrote ${catalog.length} tools to ${outPath}`);
  catalog.forEach((t) => console.log(`  - ${t.name}`));
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
}
