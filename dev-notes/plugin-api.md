# Plugin API Notes

## register() Export

The plugin loader resolves exports in this order:
1. If module has `default` export, unwrap it
2. If result is a function → treated as `register(api)`
3. If result is an object → looks for `.register` or `.activate` method

Our plugin exports a named `register` function. When loaded via jiti with `interopDefault: true`, the module object looks like `{ register: fn, ... }` and the loader extracts `register` from the object.

## api.config vs api.pluginConfig

- `api.config` — the **global** OpenClaw config (entire `openclaw.json`)
- `api.pluginConfig` — the validated per-plugin config from `plugins.entries.<id>.config`

Plugin-specific settings must be nested under `config` in the entry:

```json
{
  "plugins": {
    "entries": {
      "remoteclaw": {
        "enabled": true,
        "config": {
          "gatewayUrl": "http://localhost:18789",
          "gatewayToken": "...",
          "sessionKey": "main"
        }
      }
    }
  }
}
```

The normalization code in `config-state.ts` extracts `enabled` and `config` separately:
```ts
normalized[key] = {
  enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
  config: "config" in entry ? entry.config : undefined,
};
```

## Service Interface

The real `OpenClawPluginService` type uses `id` (not `name`):

```ts
type OpenClawPluginService = {
  id: string;
  start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
};
```

The `start()` method receives a context with `config`, `workspaceDir`, `stateDir`, and `logger`. Our plugin ignores it (typed as `unknown`) since we read config from `api.pluginConfig` during registration.

## Config Schema Requirement

Plugins **must** have a `configSchema` in their `openclaw.plugin.json` manifest. Without it, the loader sets status to `"error"` with message `"missing config schema"`.
