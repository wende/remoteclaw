# Plugin Discovery Gotchas

## Symlinks Are Not Followed

OpenClaw's plugin discovery uses `fs.readdirSync(dir, { withFileTypes: true })` and checks `entry.isDirectory()`. On macOS/Linux, `Dirent.isDirectory()` returns `false` for symlinks — even symlinks pointing to directories.

```
~/.openclaw/extensions/remoteclaw → /path/to/real/dir
                                      ↑ isDirectory() = false
                                      ↑ isSymbolicLink() = true
```

**Workaround**: Use `plugins.load.paths` in `openclaw.json` instead of placing symlinks in `~/.openclaw/extensions/`. The `discoverFromPath` codepath uses `fs.statSync()` which follows symlinks.

```json
{
  "plugins": {
    "load": {
      "paths": ["/absolute/path/to/remoteclaw"]
    }
  }
}
```

## Config Validation Runs Before Plugin Loading

The config validator calls `loadPluginManifestRegistry()` → `discoverOpenClawPlugins()` to build a set of known plugin IDs. If a plugin ID appears in `plugins.entries` but wasn't discovered, the config is rejected as invalid. This means discovery must succeed before the config is accepted.

## Discovery Search Order

1. `plugins.load.paths` (from config) — uses `discoverFromPath` (follows symlinks via `statSync`)
2. Workspace extensions: `<workspace>/.openclaw/extensions/`
3. Global extensions: `~/.openclaw/extensions/` — uses `discoverInDirectory` (does NOT follow symlinks)
4. Bundled extensions: installed package's `extensions/` directory
