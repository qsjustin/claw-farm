# claw-farm

Multi OpenClaw instance manager — scaffold, run, and deploy AI agents with persistent memory.

## Features

- **One-command scaffolding**: `claw-farm init my-agent` creates a full OpenClaw project with Docker Compose, config, and memory structure
- **2-Layer Memory Architecture**: Raw data is immutable (never deleted), processing layer is swappable
- **Multiple processors**: Builtin (MEMORY.md) or Mem0+Qdrant for semantic vector search
- **Multi-instance management**: Run multiple OpenClaw agents with auto-assigned ports
- **Cloud-ready**: Generate unified docker-compose for Coolify/Hetzner deployment

## Install

```bash
# Requires Bun (https://bun.sh)
git clone https://github.com/PermissionLabs/claw-farm.git
cd claw-farm && bun install

# Add alias (optional)
alias claw-farm='bun run /path/to/claw-farm/src/index.ts'
```

> **npm publish is planned** — `bun install -g @permissionlabs/claw-farm` will work once published.

## Quick Start

```bash
# Scaffold a new agent
mkdir my-agent && cd my-agent
bun run /path/to/claw-farm/src/index.ts init my-agent

# Configure API keys
cp .env.example .env
# Edit .env with your GEMINI_API_KEY

# Start
claw-farm up my-agent

# Open dashboard
open http://localhost:18789
```

## Commands

| Command | Description |
|---------|-------------|
| `claw-farm init <name>` | Scaffold OpenClaw project |
| `claw-farm init <name> --processor mem0` | Scaffold with Mem0+Qdrant |
| `claw-farm init <name> --existing` | Register existing project |
| `claw-farm up [name\|--all]` | Start containers |
| `claw-farm down [name\|--all]` | Stop containers |
| `claw-farm list` | Show all projects + status |
| `claw-farm memory:rebuild [name]` | Rebuild memory from raw data |
| `claw-farm cloud:compose` | Generate cloud deployment compose |

## Memory Architecture

```
Layer 0: Raw Storage (immutable, append-only, never deleted)
  └─ raw/sessions/*.jsonl     ← OpenClaw session logs
  └─ raw/workspace-snapshots/ ← MEMORY.md, SOUL.md snapshots

Layer 1: Processing (swappable, rebuildable)
  └─ processed/               ← Can be wiped and rebuilt anytime
  └─ claw-farm memory:rebuild ← One command to re-index from raw
```

## Generated Project Structure

```
my-agent/
  docker-compose.openclaw.yml   # Docker Compose config
  .claw-farm.json                # Project settings
  .env.example                   # API key template
  openclaw/
    config/openclaw.json5        # LLM config
    workspace/
      SOUL.md                    # Agent personality
      MEMORY.md                  # Agent memory
      skills/                    # Custom skills
    raw/                         # Layer 0: immutable
      sessions/                  # Session logs (.jsonl)
      workspace-snapshots/       # Periodic snapshots
    processed/                   # Layer 1: rebuildable
```

## Cloud Deployment (Coolify + Hetzner)

```bash
# Generate unified compose for all registered projects
claw-farm cloud:compose

# Deploy to Coolify via git push
git add docker-compose.cloud.yml
git push origin main
# Coolify auto-deploys on push
```

Recommended: Hetzner CX22 (~€4.35/mo) with Coolify self-hosted.

## License

MIT — PermissionLabs
