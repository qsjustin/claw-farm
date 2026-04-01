---
name: claw-farm-cli
description: Use this skill when working with claw-farm CLI commands — scaffolding, starting, stopping, spawning, upgrading, or managing AI agent projects. Triggers on claw-farm, openclaw, picoclaw, agent instance, spawn, despawn keywords.
user-invocable: true
argument-hint: "[command-name]"
---

# claw-farm CLI Reference

claw-farm is a multi-instance AI agent manager. It scaffolds, runs, and deploys agents with persistent memory using Docker Compose.

**Install:** `bun add -g @permissionlabs/claw-farm` or run directly: `bunx @permissionlabs/claw-farm`

## Commands

### init — Scaffold a new project
```bash
claw-farm init <name> [options]
```
| Flag | Default | Description |
|------|---------|-------------|
| `--runtime openclaw\|picoclaw` | openclaw | Agent runtime (~1.5GB vs ~20MB) |
| `--processor builtin\|mem0` | builtin | Memory processor (text vs vector) |
| `--llm gemini\|anthropic\|openai-compat` | gemini | LLM provider |
| `--proxy-mode shared\|per-instance` | per-runtime | API proxy sharing strategy |
| `--multi` | false | Enable multi-instance (template/ + instances/) |
| `--existing` | false | Register existing project without scaffolding |

Name rules: lowercase alphanumeric + hyphens, max 63 chars.

### up — Start containers
```bash
claw-farm up [name|--all]
claw-farm up <name> --user <id>    # Start specific instance
```

### down — Stop containers
```bash
claw-farm down [name|--all]
claw-farm down <name> --user <id>  # Stop specific instance
```

### spawn — Create + start instance (multi-instance)
```bash
claw-farm spawn <project> --user <id> [--context k=v k2=v2] [--no-start]
```
- Auto-migrates single-instance to multi-instance if needed
- `--context` fills USER.template.md placeholders (e.g., `--context name=Alice lang=en`)

### despawn — Stop + remove instance
```bash
claw-farm despawn <project> --user <id> [--keep-data]
```

### instances — List instances
```bash
claw-farm instances <project>
```
Shows user ID, port, status (running/stopped), creation date.

### list (ls) — Show all projects
```bash
claw-farm list
```

### upgrade — Update templates
```bash
claw-farm upgrade [name] [--force-policy]
```
Re-generates docker-compose and config from latest templates. Preserves user customizations via config merging.

### memory:rebuild — Rebuild Layer 1
```bash
claw-farm memory:rebuild [name] [--user <id>]
```
Rebuilds processed/ from raw/ workspace snapshots.

### migrate-runtime — Switch runtime
```bash
claw-farm migrate-runtime <project> --to <runtime>
```
Migrates SOUL.md, USER.md, MEMORY.md, skills/, sessions between openclaw and picoclaw.

### cloud:compose — Generate cloud deployment
```bash
claw-farm cloud:compose [outfile]
```
Outputs unified docker-compose with nginx reverse proxy, shared api-proxy, resource limits.

## Runtime Comparison

| | openclaw | picoclaw |
|---|---------|----------|
| Size | ~1.5GB (Node.js) | ~20MB (Go) |
| Config | openclaw.json + policy.yaml | Single config.json |
| Default proxy | per-instance | shared |
| Memory path | workspace/MEMORY.md | workspace/memory/MEMORY.md |
| Mem0 support | Yes | Not yet |

## Proxy Modes

- **per-instance**: Each instance has its own api-proxy. Secrets isolated per user.
- **shared**: All instances share one api-proxy (hub-and-spoke network). Same API key for all.

## Global Registry

Located at `~/.claw-farm/registry.json`. Tracks all projects, auto-assigns ports starting from 18789.

## Environment

Requires `.env` file with API key for chosen LLM provider:
- Gemini: `GEMINI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- OpenAI-compat: `OPENAI_API_KEY` + `OPENAI_BASE_URL`

## Programmatic API

```typescript
import { spawn, despawn } from "@permissionlabs/claw-farm/lib/api";

await spawn({ project: "my-project", userId: "user-1", context: { name: "Alice" } });
await despawn("my-project", "user-1", { keepData: false });
```
