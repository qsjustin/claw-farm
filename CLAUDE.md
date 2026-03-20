# claw-farm

Multi OpenClaw instance manager — scaffold, run, and deploy AI agents with persistent memory.

## Project Overview

- **Runtime:** Bun (zero npm dependencies, Bun built-ins only)
- **Language:** TypeScript (strict, allowImportingTsExtensions)
- **Package:** `@permissionlabs/claw-farm`
- **Repo:** github.com/PermissionLabs/claw-farm (public, MIT)

## Architecture

```
claw-farm CLI
  ├── commands/        # init, up, down, list, memory:rebuild, cloud:compose
  ├── lib/             # registry, compose, config, ports, raw-collector
  ├── processors/      # interface, builtin (MEMORY.md), mem0 (Qdrant)
  └── templates/       # docker-compose, openclaw.json5, SOUL.md, policy.yaml, api-proxy, nginx
```

### 2-Layer Memory Architecture
- **Layer 0 (raw/):** Immutable, append-only. Session logs + workspace snapshots. NEVER delete.
- **Layer 1 (processed/):** Swappable processors. Can be wiped and rebuilt from Layer 0.

### Security Architecture (API Proxy Pattern)
```
OpenClaw ──(internal net, no API key)──→ api-proxy ──(key injection + PII filter)──→ Gemini API
```
- OpenClaw container has NO API keys and NO direct internet access
- api-proxy sidecar: key injection, PII scanning/redaction, content size limits, audit logging
- All containers: read-only rootfs, cap_drop ALL, resource limits, tmpfs

## Commands

```bash
bun run src/index.ts init <name>                  # Scaffold project
bun run src/index.ts init <name> --processor mem0  # With Mem0+Qdrant
bun run src/index.ts init <name> --existing        # Register existing project
bun run src/index.ts up [name|--all]               # Start containers
bun run src/index.ts down [name|--all]             # Stop containers
bun run src/index.ts list                          # Show all projects
bun run src/index.ts memory:rebuild [name]         # Rebuild Layer 1 from raw
bun run src/index.ts cloud:compose [outfile]       # Generate cloud compose
```

## Development

```bash
bun install              # Install dev deps (bun-types, typescript)
bun run typecheck        # tsc --noEmit
bun run src/index.ts     # Run CLI
```

## Global Registry

`~/.claw-farm/registry.json` — tracks all projects, auto-assigns ports starting from 18789.

## Conventions

- Korean as default language for user-facing templates (SOUL.md, etc.)
- GitHub org: PermissionLabs (always)
- Squash merge only, branch protection on main
- Commit messages: English, concise, "why" not "what"

## Security Reference

See `docs/SECURITY.md` for comprehensive OpenClaw security hardening guide based on 2026-03-20 research.
