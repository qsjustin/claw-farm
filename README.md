# claw-farm

Multi-runtime AI agent manager — scaffold, run, and deploy agents with persistent memory. Supports OpenClaw and picoclaw runtimes.

## Features

- **One-command scaffolding**: `claw-farm init my-agent` creates a full agent project with Docker Compose, config, and memory structure
- **Multi-runtime**: OpenClaw (full-featured, ~1.5GB) or picoclaw (lightweight Go, ~20MB)
- **Security by default**: API proxy sidecar isolates keys from the agent, auto-redacts PII, scans LLM responses for secrets
- **2-Layer Memory Architecture**: Raw data is immutable (never deleted), processing layer is swappable
- **Multiple processors**: Builtin (MEMORY.md) or Mem0+Qdrant for semantic vector search
- **Multi-instance management**: Run multiple agents with auto-assigned ports
- **Cloud-ready**: Generate unified docker-compose for Coolify/Hetzner deployment

## Install

```bash
# Requires Bun (https://bun.sh)
git clone https://github.com/PermissionLabs/claw-farm.git
cd claw-farm && bun install

# Add alias to your shell profile (~/.zshrc or ~/.bashrc)
echo 'alias claw-farm="bun run ~/path/to/claw-farm/src/index.ts"' >> ~/.zshrc
source ~/.zshrc
```

> **npm publish is planned** — `bun install -g @permissionlabs/claw-farm` will work once published.

## Quick Start — New Project

```bash
mkdir my-agent && cd my-agent
claw-farm init my-agent

# Configure API keys
cp .env.example .env
vi .env  # Add your GEMINI_API_KEY

# Start
claw-farm up my-agent

# Open dashboard
open http://localhost:18789
```

## Quick Start — Existing Project

If you already have an OpenClaw setup (e.g., with docker-compose.yml):

```bash
cd ~/projects/my-existing-agent
claw-farm init my-agent --existing --processor mem0
```

This will:
1. Register the project in the global registry (auto-assign port)
2. Create `openclaw/sessions/` directories (Layer 0 memory preservation)
3. Generate `api-proxy/` sidecar (key isolation + PII filter)
4. Generate `policy.yaml` (tool access restrictions)
5. **NOT** overwrite your existing docker-compose.yml or openclaw config

## Commands

| Command | Description |
|---------|-------------|
| `claw-farm init <name>` | Scaffold agent project (default: OpenClaw) |
| `claw-farm init <name> --runtime <rt>` | Set runtime (openclaw\|picoclaw) |
| `claw-farm init <name> --proxy-mode <mode>` | Set proxy mode (per-instance\|shared) |
| `claw-farm init <name> --multi` | Scaffold multi-instance project (template/ structure) |
| `claw-farm init <name> --processor mem0` | Scaffold with Mem0+Qdrant |
| `claw-farm init <name> --llm <provider>` | Set LLM provider (gemini\|anthropic\|openai-compat) |
| `claw-farm init <name> --existing` | Register existing project + add security layer |
| `claw-farm up [name\|--all]` | Start Docker Compose |
| `claw-farm up <name> --user <id>` | Start specific instance |
| `claw-farm down [name\|--all]` | Stop Docker Compose |
| `claw-farm down <name> --user <id>` | Stop specific instance |
| `claw-farm spawn <project> --user <id>` | Create and start instance from template |
| `claw-farm despawn <project> --user <id>` | Stop and remove instance |
| `claw-farm instances <project>` | List all instances for a project |
| `claw-farm list` | Show all projects + status |
| `claw-farm upgrade [name]` | Re-generate claw-farm files with latest templates |
| `claw-farm upgrade [name] --force-policy` | Upgrade and overwrite policy.yaml |
| `claw-farm memory:rebuild [name]` | Rebuild memory from raw data |
| `claw-farm cloud:compose [outfile]` | Generate cloud deployment compose |

## Quick Start — Multi-Instance (Per-User Isolation)

When multiple users share one agent (e.g., each user has their own dog):

```bash
mkdir dog-agent && cd dog-agent
claw-farm init dog-agent --multi

# Customize template/SOUL.md (shared personality) and
# template/USER.template.md (per-user placeholders)

# Spawn instances for each user
claw-farm spawn dog-agent --user alice --context name=Poppy breed=Maltese age=3
claw-farm spawn dog-agent --user bob --context name=Max breed=Golden age=5

# List instances
claw-farm instances dog-agent

# Programmatic API (for signup flows)
# import { spawn } from "@permissionlabs/claw-farm"
```

Each user gets: isolated MEMORY.md, their own USER.md, own port.
Shared across users: SOUL.md, AGENTS.md, skills/, config/.

## picoclaw Runtime

picoclaw is a lightweight Go-based agent runtime (~20MB vs OpenClaw's ~1.5GB). Use it when you need resource-efficient agents or are deploying many instances.

```bash
# Scaffold with picoclaw
claw-farm init my-agent --runtime picoclaw

# With shared proxy (all instances share one api-proxy)
claw-farm init my-agent --runtime picoclaw --proxy-mode shared --multi
```

**Key differences from OpenClaw:**
- Single `config.json` instead of `openclaw.json` + `policy.yaml`
- Memory at `workspace/memory/MEMORY.md` (not `workspace/MEMORY.md`)
- Sessions at `workspace/sessions/` (not a separate `sessions/` directory)
- 75x smaller container image

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full picoclaw architecture diagrams.

## Security Architecture

```
User ──→ OpenClaw Dashboard (localhost:18789)
           │
           │ Agent calls LLM
           ▼
        ┌──────────────────────────────────────────┐
        │  api-proxy (internal network only)         │
        │                                            │
        │  Outbound: PII auto-redacted               │
        │    "SSN 880101-1234567"                    │
        │    → "[REDACTED_KR_RRN]"                   │
        │                                            │
        │  API key injected (agent never sees it)    │
        │                                            │
        │  ──→ Gemini API ──→ Response               │
        │                                            │
        │  Inbound: Secrets stripped                  │
        │    "Found key: sk-ant-abc123..."           │
        │    → "[REDACTED_ANTHROPIC_KEY]"            │
        │                                            │
        │  Audit log: logs/api-proxy-audit.jsonl     │
        └──────────────────────────────────────────┘
```

**PII patterns detected:** Korean RRN/phone, US SSN/phone, credit cards, emails
**Secret patterns detected:** Google/OpenAI/Anthropic/GitHub/AWS/Stripe keys, JWTs, private keys
**PII mode:** `PII_MODE=redact` (default) | `block` | `warn`

See [docs/SECURITY.md](docs/SECURITY.md) for the full security hardening guide.

## Memory Architecture

```
Layer 0: Raw Storage (immutable, append-only, never deleted)
  └─ openclaw/sessions/*.jsonl ← OpenClaw session logs
  └─ raw/workspace-snapshots/  ← MEMORY.md, SOUL.md snapshots

Layer 1: Processing (swappable, rebuildable)
  └─ processed/               ← Can be wiped and rebuilt anytime
  └─ claw-farm memory:rebuild ← One command to re-index from raw
```

## Generated Project Structure

```
my-agent/
  docker-compose.openclaw.yml   # Docker Compose (hardened)
  .claw-farm.json                # Project settings
  .env.example                   # API key template
  api-proxy/                     # Security sidecar
    api_proxy.py                 #   Key injection + PII redaction + secret scanning
    Dockerfile
    requirements.txt
  openclaw/                        # Mounted as /home/node/.openclaw
    openclaw.json                # LLM config (routes through proxy, no raw keys)
    policy.yaml                  # Tool access restrictions
    workspace/
      SOUL.md                    # Agent personality
      MEMORY.md                  # Agent memory
      skills/                    # Custom skills
    sessions/                    # Layer 0: immutable session logs (.jsonl)
    logs/                        # Agent audit logs
  raw/workspace-snapshots/       # Periodic workspace snapshots
  processed/                     # Layer 1: rebuildable
  logs/                          # API proxy audit logs
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

## Documentation

| Document | Contents |
|----------|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full architecture diagrams |
| [docs/SECURITY.md](docs/SECURITY.md) | Security hardening guide |
| [docs/ko/](docs/ko/) | Korean translations |

## License

MIT — PermissionLabs
