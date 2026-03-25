# claw-farm

Multi OpenClaw instance manager — scaffold, run, and deploy AI agents with persistent memory.

## MANDATORY: Documentation Sync Rule

> **When you change architecture, file structure, security, container topology, or data flow, you MUST update the corresponding docs.**
>
> | Document | Role | When to update |
> |----------|------|---------------|
> | `docs/ARCHITECTURE.md` | **Architecture source of truth.** Diagrams, file structure, topology, data flow | Update **first** on any structural change |
> | `docs/SECURITY.md` | Security design rationale, threat model, checklists | On security-related changes |
> | `README.md` | External user guide | On command/install/structure changes |
> | `CLAUDE.md` (this file) | AI agent + developer instructions | On convention/rule changes |
>
> **`docs/ARCHITECTURE.md` is the single source of truth for architecture.** Other docs follow it. On conflict, ARCHITECTURE.md wins.
>
> ### Checklist: Adding a new command or template
>
> When you add a new CLI command (`src/commands/`) or template (`src/templates/`), you **MUST** update ALL of the following:
>
> 1. `docs/ARCHITECTURE.md` — Section 1 CLI diagram + any relevant sections
> 2. `docs/ko/ARCHITECTURE.md` — Korean translation of the same changes
> 3. `CLAUDE.md` — Architecture summary tree AND Commands section
> 4. `README.md` — Commands table
> 5. `src/index.ts` — HELP text (already required for the code to work)
>
> **Missing even one of these is a bug.** Treat doc updates as part of the PR, not a follow-up.

## Project Overview

- **Runtime:** Bun (zero npm dependencies, Bun built-ins only)
- **Language:** TypeScript (strict, allowImportingTsExtensions)
- **Package:** `@permissionlabs/claw-farm`
- **Repo:** github.com/PermissionLabs/claw-farm (public, MIT)

## Architecture (summary)

> Full diagrams: `docs/ARCHITECTURE.md`

```
claw-farm CLI
  ├── commands/        # init, up, down, list, spawn, despawn, instances, upgrade, memory:rebuild, cloud:compose
  ├── lib/             # registry, compose, config, ports, raw-collector, instance, migrate, api
  ├── processors/      # interface, builtin (MEMORY.md), mem0 (Qdrant)
  └── templates/       # docker-compose, docker-compose.instance, docker-compose.mem0, USER.template, openclaw.json, SOUL.md, policy.yaml, api-proxy, nginx-proxy
```

**Multi-Instance:** `init --multi` creates `template/` + `instances/` structure. `spawn --user` creates per-user isolated instances with shared template files.

**Security:** `OpenClaw ──(no key)──→ api-proxy ──(PII redaction + key injection)──→ Gemini API ──→ (secret scan) ──→ agent`

**Memory:** Layer 0 (raw/, immutable) → Layer 1 (processed/, swappable)

## Commands

```bash
bun run src/index.ts init <name>                   # Scaffold project
bun run src/index.ts init <name> --multi           # Scaffold multi-instance project
bun run src/index.ts init <name> --processor mem0  # With Mem0+Qdrant
bun run src/index.ts init <name> --llm anthropic   # Set LLM provider (gemini|anthropic|openai-compat)
bun run src/index.ts init <name> --existing        # Register existing + add security layer
bun run src/index.ts up [name|--all]               # Start containers
bun run src/index.ts up <name> --user <id>         # Start specific instance
bun run src/index.ts down [name|--all]             # Stop containers
bun run src/index.ts down <name> --user <id>       # Stop specific instance
bun run src/index.ts spawn <project> --user <id>   # Create + start instance from template
bun run src/index.ts despawn <project> --user <id> # Stop + remove instance
bun run src/index.ts instances <project>           # List all instances
bun run src/index.ts list                          # Show all projects
bun run src/index.ts memory:rebuild [name]         # Rebuild Layer 1 from raw
bun run src/index.ts upgrade [name]                 # Re-generate templates to latest
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

- Default language for user-facing templates (SOUL.md, etc.): English
- GitHub org: PermissionLabs (always)
- Squash merge only, branch protection on main
- Commit messages: English, concise, "why" not "what"

## Key Documentation

| Document | Contents |
|----------|----------|
| `docs/ARCHITECTURE.md` | Full architecture diagrams (file structure, container topology, data flow, memory, onboarding) |
| `docs/SECURITY.md` | OpenClaw security hardening guide (2026-03-20 research, 8 sources) |
| `docs/ko/` | Korean translations of docs |
| `README.md` | User guide (install, quickstart, command reference) |

---

## For AI Agents: How to Use claw-farm in Other Projects

If you're an AI agent working in a project that uses claw-farm (e.g., dog-agent, tamagochi), here's what you need to know.

**Read `docs/ARCHITECTURE.md` first for full context.**

### Check if this project is managed by claw-farm
Look for `.claw-farm.json` in the project root:
```json
{
  "name": "project-name",
  "processor": "builtin" or "mem0",
  "port": 18789,
  "createdAt": "2026-03-20T...",
  "multiInstance": true  // optional — if true, uses template/ + instances/ structure
}
```

### Key files (single-instance)

| File | Purpose | Can you edit? |
|------|---------|---------------|
| `openclaw/workspace/SOUL.md` | Agent personality & behavior rules | Yes — this defines who you are |
| `openclaw/workspace/MEMORY.md` | Accumulated agent memory | Yes — OpenClaw updates this automatically |
| `openclaw/workspace/skills/` | Custom skills directory | Yes — add new skills here |
| `openclaw/config/openclaw.json` | LLM model & plugin config | Only if user asks |
| `openclaw/config/policy.yaml` | Tool access restrictions | Only if user asks |
| `openclaw/raw/` | Immutable session logs | **NEVER delete or modify** |
| `api-proxy/api_proxy.py` | Security proxy | Only if user asks |
| `docker-compose.openclaw.yml` | Container orchestration | Only if user asks |

### Key files (multi-instance)

| File | Purpose | Can you edit? |
|------|---------|---------------|
| `template/SOUL.md` | Shared agent personality | Yes — shared across all instances |
| `template/AGENTS.md` | Shared behavior rules | Yes — shared across all instances |
| `template/skills/` | Shared custom skills | Yes — shared across all instances |
| `template/USER.template.md` | Per-user context template | Yes — defines placeholders |
| `instances/<user>/USER.md` | Per-user context (filled) | Yes — user-specific info |
| `instances/<user>/MEMORY.md` | Per-user memory | Yes — isolated per user |
| `instances/<user>/raw/` | Per-user immutable logs | **NEVER delete or modify** |

### Security rules
1. **API keys are NOT in your environment.** They're in the api-proxy container. Don't look for them.
2. **Outbound requests are PII-filtered.** Sensitive patterns (SSN, phone numbers, etc.) are automatically redacted.
3. **LLM responses are secret-scanned.** API keys or tokens in responses are stripped before reaching you.
4. **raw/ is sacred.** Layer 0 data is append-only and never deleted.
5. **processed/ is disposable.** Layer 1 can be wiped and rebuilt with `claw-farm memory:rebuild`.

### Register / start / stop
```bash
claw-farm init project-name --existing --processor mem0
claw-farm up project-name
claw-farm down project-name
```

### If you change the architecture
**You MUST update `docs/ARCHITECTURE.md` first**, then sync other docs. See the "Documentation Sync Rule" at the top.
