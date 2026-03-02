# RemoteClaw Project Rules

## Critical Constraint

**NEVER modify OpenClaw (`/Users/wende/projects/openclaw`)**

RemoteClaw is a plugin for OpenClaw, but we have NO rights to modify the OpenClaw repository itself. Any necessary integrations must be achieved by:
- Modifying only RemoteClaw code
- Using OpenClaw's public APIs and plugin interfaces
- Direct execution of tool objects (when available in-process)
- Falling back to HTTP proxying when needed

If a feature seems to require OpenClaw changes, reconsider the RemoteClaw-only approach first (e.g., direct tool execution instead of HTTP proxy).

## Project Structure

- **remoteclaw/** — This repository (what we can modify)
- **~/projects/openclaw/** — Upstream project (read-only reference only)

## Architecture Notes

RemoteClaw runs as a plugin **inside** the OpenClaw gateway process, which enables:
- Direct tool object execution (calling `.execute()` methods in-process)
- Access to the plugin registry via `globalThis`
- Avoiding the need to modify gateway HTTP endpoints

Leverage this in-process execution capability when working around limitations.
