# claw-farm Architecture

> **This document is the single source of truth for the project's architecture.**
> When the structure changes, update this document **first**.
> CLAUDE.md and README.md reference this document.
>
> Korean version: [ko/ARCHITECTURE.md](ko/ARCHITECTURE.md)

## 1. What the CLI Does

```
┌─────────────────────────────────────────────────────────────────┐
│                        Developer                                 │
│                                                                 │
│  $ claw-farm init dog-agent --processor mem0                    │
│  $ claw-farm init tamagochi --llm anthropic                     │
│  $ claw-farm init tutor-bot --processor mem0 --llm openai-compat│
│  $ claw-farm init lite-bot --runtime picoclaw                   │
│  $ claw-farm init shared-bot --runtime picoclaw --proxy-mode shared│
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     claw-farm CLI                                │
│                   (Bun script, zero deps)                       │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │   init   │ │  up/down │ │   list   │ │ memory:rebuild   │   │
│  │          │ │          │ │          │ │                   │   │
│  │ scaffold │ │ docker   │ │ status   │ │ raw→processed    │   │
│  │ register │ │ compose  │ │ table    │ │ rebuild          │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │  spawn   │ │ despawn  │ │instances │ │ cloud:compose    │   │
│  │          │ │          │ │          │ │                   │   │
│  │ create   │ │ stop +   │ │ list per │ │ merge all into   │   │
│  │ instance │ │ remove   │ │ project  │ │ single compose   │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│                                                                 │
│  ┌──────────┐                                                   │
│  │ upgrade  │                                                   │
│  │          │                                                   │
│  │ re-gen   │                                                   │
│  │ templates│                                                   │
│  └──────────┘                                                   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Global Registry  ~/.claw-farm/registry.json              │   │
│  │                                                          │   │
│  │  dog-agent  → /Users/.../dog-agent    port 18789         │   │
│  │  tamagochi  → /Users/.../tamagochi    port 18790         │   │
│  │  tutor-bot  → /Users/.../tutor-bot    port 18791         │   │
│  │                                                          │   │
│  │  nextPort: 18792                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## 2. Generated File Structure

```
my-agent/
│
├── .claw-farm.json                 ← Project meta (name, port, processor, llm, runtime, proxyMode)
├── .env.example                    ← LLM_PROVIDER + API keys (per --llm flag)
├── docker-compose.openclaw.yml     ← Full stack definition
│
├── api-proxy/                      ← ★ Security sidecar (auto-generated)
│   ├── api_proxy.py                    PII redaction + key injection + secret scan
│   ├── Dockerfile
│   └── requirements.txt
│
├── openclaw/                       ← Mounted as /home/node/.openclaw
│   ├── openclaw.json              ← LLM config (no keys! routes through proxy)
│   ├── policy.yaml                 ← Tool access restrictions (fs, http, shell)
│   ├── workspace/                  ← ★ Agent read/write space
│   │   ├── SOUL.md                     Personality & behavior rules
│   │   ├── MEMORY.md                   Accumulated via conversations
│   │   └── skills/                     Custom skills
│   ├── sessions/                   ← ★ Layer 0: NEVER delete (.jsonl logs)
│   └── logs/                       ← Agent audit logs
│
├── raw/                            ← Workspace snapshots (auto-snapshot on up/down)
│   └── workspace-snapshots/
├── processed/                      ← Layer 1: disposable, rebuildable
├── logs/                           ← API proxy audit logs
│
├── nginx/                          ← (cloud:compose generates)
│   └── nginx.conf                     Reverse proxy for cloud deploy
│                                      (auth, rate limiting, TLS termination)
│
├── mem0/                           ← (--processor mem0 only)
│   ├── mem0_server.py
│   ├── Dockerfile
│   └── requirements.txt
│
└── data/qdrant/                    ← (--processor mem0 only)
```

## 3. Container Topology

### Local Development (default)

Single network, no nginx. Both containers share `proxy-net` (non-internal)
for simplicity. Network isolation is enforced in production via `cloud:compose`.

```
┌──────────────────────────────────────────────────────┐
│                    Docker                             │
│                                                      │
│   ┌─ proxy-net ──────────────────────────────┐       │
│   │                                           │       │
│   │  ┌──────────────┐    ┌──────────────────┐│       │
│   │  │  api-proxy   │    │    openclaw      ││       │
│   │  │              │◄───│                  ││       │
│   │  │ Holds        │    │ NO API keys     ││       │
│   │  │ GEMINI_API_  │    │ Loads SOUL.md   ││       │
│   │  │ KEY          │    │ R/W MEMORY.md   ││       │
│   │  │ :8080        │    │ :18789 → host   ││       │
│   │  └──────┬───────┘    └──────────────────┘│       │
│   └─────────┼────────────────────────────────┘       │
│             ▼                                        │
│     generativelanguage.googleapis.com                │
└──────────────────────────────────────────────────────┘
      │
      ▼
  localhost:18789 ──→ Browser dashboard
```

### Production (cloud:compose) — Full Network Isolation

nginx reverse proxy handles port binding + TLS + rate limiting.
openclaw is fully isolated on internal network — no internet access.

```
┌──────────────────────────────────────────────────────────────┐
│                         Docker                                │
│                                                              │
│  ┌─ public-net ──────────────────────────────┐               │
│  │  ┌──────────────┐                         │               │
│  │  │    nginx     │  :18789 → host          │               │
│  │  │  TLS + auth  │                         │               │
│  │  │  rate limit  │                         │               │
│  │  └──────┬───────┘                         │               │
│  └─────────┼─────────────────────────────────┘               │
│            │                                                  │
│  ┌─ proxy-net (internal: true) ──────────────────────┐       │
│  │         │                                          │       │
│  │  ┌──────▼───────┐    ┌──────────────────┐         │       │
│  │  │   openclaw   │    │   api-proxy      │         │       │
│  │  │              │───►│                  │         │       │
│  │  │ NO API keys  │    │ Key inject       │         │       │
│  │  │ NO internet  │    │ PII redact       │         │       │
│  │  │              │    │ Secret scan      │         │       │
│  │  └──────────────┘    └──────┬───────────┘         │       │
│  └─────────────────────────────┼─────────────────────┘       │
│                                │                              │
│  ┌─ egress-net ────────────────┼─────────────────────┐       │
│  │                     ┌───────┘                     │       │
│  │                     ▼                             │       │
│  │         generativelanguage.googleapis.com          │       │
│  └───────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘
```

### Mem0 Processor (4-tier)

```
┌──────────────────────────────────────────────────────────────┐
│                         Docker                                │
│                                                              │
│  ┌─ proxy-net (outbound OK) ────────────────────────┐        │
│  │                                                   │        │
│  │  ┌──────────────┐        ┌──────────────────┐    │        │
│  │  │  api-proxy   │◄───────│    openclaw      │    │        │
│  │  │  Key inject  │        │    NO keys       │    │        │
│  │  │  PII redact  │        │    :18789 → host │    │        │
│  │  │  Secret scan │        │                  │    │        │
│  │  │  :8080       │        └────────┬─────────┘    │        │
│  │  └──────┬───────┘                 │              │        │
│  └─────────┼─────────────────────────┼──────────────┘        │
│            │                         │                       │
│            ▼  External               │                       │
│    googleapis.com                    │                       │
│                                      │                       │
│  ┌─ frontend (internal: true) ───────┼──────────────┐        │
│  │                                   │              │        │
│  │                           ┌───────▼────────┐     │        │
│  │                           │   mem0-api     │     │        │
│  │                           │   FastAPI      │     │        │
│  │                           │   :8050        │     │        │
│  │                           └───────┬────────┘     │        │
│  └───────────────────────────────────┼──────────────┘        │
│                                      │                       │
│  ┌─ backend (internal: true) ────────┼──────────────┐        │
│  │                           ┌───────▼────────┐     │        │
│  │                           │    qdrant      │     │        │
│  │                           │  Vector DB     │     │        │
│  │                           │  :6333         │     │        │
│  │                           └────────────────┘     │        │
│  └──────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

**Network isolation rules (production / cloud:compose):**
- `public-net`: nginx only. Host port binding + TLS termination.
- `proxy-net` (internal): nginx ↔ openclaw ↔ api-proxy. No internet access.
- `egress-net`: api-proxy only. Outbound to Gemini API.
- `frontend` (internal, mem0 only): OpenClaw ↔ Mem0 only.
- `backend` (internal, mem0 only): Mem0 ↔ Qdrant only.

**Local development:** Single `proxy-net` (non-internal) for simplicity.

## 4. Security Data Flow

```
User: "My dog's phone is 010-1234-5678 and SSN 880101-1234567..."
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw (agent)                                             │
│                                                             │
│  1. Loads SOUL.md → "I am a dog specialist AI"              │
│  2. Loads MEMORY.md → "Poppy is a 3-year-old Maltese"       │
│  3. Sends user message + context to LLM                     │
│     → http://api-proxy:8080                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ api-proxy (security layer)                                   │
│                                                             │
│  ★ OUTBOUND (agent → LLM)                                  │
│                                                             │
│  Original: "phone 010-1234-5678, SSN 880101-1234567"        │
│                    ↓ PII redaction                           │
│  Sent:     "phone [REDACTED_KR_PHONE],                      │
│             SSN [REDACTED_KR_RRN]"                          │
│                                                             │
│  + API key injected (agent never sees it)                   │
│  + Audit log written (logs/api-proxy-audit.jsonl)           │
│                                                             │
│  ──────────────────→ Gemini API ────────────────→           │
│                                                             │
│  ★ INBOUND (LLM → agent)                                   │
│                                                             │
│  Original: "Found key from session: sk-ant-abc123def456..."  │
│                    ↓ Secret scan                             │
│  Returned: "Found key from session: [REDACTED_ANTHROPIC_KEY]"│
│                                                             │
│  + Audit log written                                        │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw (agent)                                             │
│                                                             │
│  4. Receives clean LLM response                             │
│  5. Updates MEMORY.md: "Poppy's owner has contact info"     │
│  6. Responds to user                                        │
│  7. Session log → sessions/ (auto-saved)                    │
└─────────────────────────────────────────────────────────────┘
```

**PII redaction targets:** Korean RRN, mobile, landline / US SSN, phone / Credit cards / Email
**Secret scan targets:** Google/OpenAI/Anthropic/GitHub/GitLab/AWS/Stripe keys, JWT, Private Key
**PII mode:** `PII_MODE=redact` (default, auto-mask) | `block` (reject) | `warn` (log only)

## 5. 2-Layer Memory

```
              ┌─────────────────────────────────┐
              │         Layer 0: raw/            │
              │       Immutable — never delete    │
              │                                 │
              │  sessions/                      │
              │    2026-03-20-session1.jsonl     │  ← Conversation originals
              │    2026-03-21-session2.jsonl     │
              │                                 │
              │  workspace-snapshots/            │
              │    2026-03-20T11-34-46/          │  ← Auto on up/down
              │      MEMORY.md                  │
              │      SOUL.md                    │
              └──────────────┬──────────────────┘
                             │
                             │  claw-farm memory:rebuild
                             │  (rebuild anytime)
                             ▼
              ┌─────────────────────────────────┐
              │       Layer 1: processed/       │
              │     Swappable — safe to wipe     │
              │                                 │
              │  Current: builtin (MEMORY.md)    │
              │       or: mem0 (Qdrant vectors)  │
              │                                 │
              │  New approach available?          │
              │   → Delete processed/            │
              │   → Swap processor               │
              │   → memory:rebuild               │
              │   → Rebuilt from raw!             │
              └─────────────────────────────────┘
```

**Principles:**
- Raw data is never deleted (prevents hallucination, enables audit trails)
- Processing layer is swappable (test new approaches instantly)
- `claw-farm memory:rebuild` re-indexes from originals in one command

## 6. Multi-Instance Architecture (Template + Per-User Isolation)

### Single-Instance (default)

Each project = one OpenClaw instance. Same as before.

### Multi-Instance (`--multi`)

When multiple users share one project (e.g., dog-agent), each user gets isolated memory and context while sharing the same agent personality and skills.

```
dog-agent/                             ← Project root
├── .claw-farm.json                    ← multiInstance: true
├── .gitignore                         ← instances/, *.env
├── api-proxy/                         ← Shared security sidecar (in git)
│
├── template/                          ← ★ Shared files (in git, read-only mount)
│   ├── SOUL.md                            Agent personality (same for all users)
│   ├── AGENTS.md                          Behavior rules (same for all users)
│   ├── skills/                            Custom skills (same for all users)
│   ├── USER.template.md                Placeholders: {{USER_ID}}, {{NAME}}, etc.
│   └── config/
│       ├── openclaw.json
│       └── policy.yaml
│
└── instances/                         ← ★ Per-user data (gitignored)
    ├── alice/
    │   ├── docker-compose.openclaw.yml    Per-instance compose
    │   ├── openclaw/                      Mounted as /home/node/.openclaw
    │   │   ├── openclaw.json                 Copied from template/config/
    │   │   ├── policy.yaml                   Copied from template/config/
    │   │   ├── workspace/
    │   │   │   ├── USER.md                "Dog: Poppy, 3yo Maltese"
    │   │   │   ├── MEMORY.md                 Alice's conversation memory
    │   │   │   └── memory/
    │   │   ├── sessions/
    │   │   └── logs/
    │   ├── raw/workspace-snapshots/
    │   └── processed/
    │
    └── bob/
        ├── docker-compose.openclaw.yml
        ├── openclaw/                      Same structure as alice
        └── ...
```

**Key design:**
- `SOUL.md` (shared): "I am a dog specialist AI" — same for all users
- `USER.md` (per-user): "Dog: Poppy, 3yo Maltese, chicken allergy" — always loaded
- `MEMORY.md` (per-user): Accumulated conversation memory — isolated per user
- `template/` → git tracked. `instances/` → gitignored (user data stays local)

### Per-Instance Container Isolation

Each instance runs its own Docker Compose stack with unique container names and port:

```
$ claw-farm instances dog-agent
┌──────────────────┬─────────┬───────────┐
│ alice             │ 18790   │ 🟢 running │
│ bob               │ 18791   │ 🟢 running │
└──────────────────┴─────────┴───────────┘
```

Each instance has its own `openclaw/` directory mounted as `/home/node/.openclaw`,
with shared template files copied into `openclaw/workspace/` at spawn/upgrade time:
```yaml
volumes:
  # Directory mount (writable — OpenClaw needs atomic rename for config)
  # Template files (SOUL.md, AGENTS.md, skills/) are copied at spawn/upgrade
  - ./openclaw:/home/node/.openclaw
```

### Multi-Instance Commands

```bash
claw-farm init dog-agent --multi             # Create template/ structure
claw-farm spawn dog-agent --user alice \
  --context name=Poppy breed=Maltese age=3   # Spawn instance from template
claw-farm spawn dog-agent --user bob         # Another instance, different port
claw-farm instances dog-agent                # List all instances
claw-farm up dog-agent --user alice          # Start specific instance
claw-farm down dog-agent --user bob          # Stop specific instance
claw-farm despawn dog-agent --user bob       # Remove instance
```

### Programmatic API (for signup flows)

```typescript
import { spawn, despawn, listInstances } from "@permissionlabs/claw-farm";

// User signs up → spawn their agent instance
const { port } = await spawn({
  project: "dog-agent",
  userId: "user-123",
  context: { name: "Poppy", breed: "Maltese", age: "3" },
});

// User's agent is now at http://localhost:${port}
```

### Migration (single → multi)

First `spawn` on a single-instance project auto-migrates:
1. Creates `template/` from existing `openclaw/workspace/` (SOUL.md, AGENTS.md, skills/, config/)
2. Sets `multiInstance: true` in registry and config
3. Creates `.gitignore` for `instances/`

### Multi-Project Overview

```
localhost
    │
    ├── :18789  dog-agent    (builtin) multi: 2 instances
    │   ├── :18790  alice
    │   └── :18791  bob
    ├── :18792  tamagochi    (builtin) single
    ├── :18793  tutor-bot    (mem0)    single
    │
    │   $ claw-farm list
    │   ┌──────────────┬───────┬───────────┬────────────┐
    │   │ dog-agent    │ 18789 │ 🟢 running │ 2          │
    │   │ tamagochi    │ 18792 │ ⚪ stopped │ -          │
    │   │ tutor-bot    │ 18793 │ 🟢 running │ -          │
    │   └──────────────┴───────┴───────────┴────────────┘
    │
    │   $ claw-farm up --all     # Start all (including all instances)
    │   $ claw-farm down --all   # Stop all
    │
    ▼
  cloud:compose → Merge into single docker-compose.cloud.yml
    │
    ▼
  Hetzner VPS + Coolify → Deploy with git push
```

## 7. Existing Project Onboarding

```
my-project (before)                 my-project (after claw-farm init --existing)
├── docker-compose.yml  ← untouched ├── docker-compose.yml    (untouched)
├── .env                            ├── .env                  (untouched)
├── openclaw/                       ├── openclaw/
│   ├── config/                     │   ├── openclaw.json     ★ added (proxy routing)
│   │   └── openclaw.json          │   ├── policy.yaml        ★ added
│   └── workspace/                  │   ├── workspace/         (untouched)
│       ├── SOUL.md                 │   ├── sessions/          ★ added
│       ├── MEMORY.md               │   └── logs/              ★ added
│       └── skills/                 ├── raw/workspace-snapshots/ ★ added
├── mem0/                           ├── processed/             ★ added
│   ├── Dockerfile                  ├── mem0/                  (untouched)
│   └── mem0_server.py              ├── api-proxy/             ★ added
└── data/qdrant/                    │   ├── api_proxy.py
                                    │   ├── Dockerfile
                                    │   └── requirements.txt
                                    ├── logs/                  ★ added
                                    └── .claw-farm.json        ★ added

★ = Added by claw-farm init --existing. Existing files are NEVER modified.
```

**Onboarding command:**
```bash
cd /path/to/existing-project
claw-farm init <name> --existing [--processor mem0] [--llm anthropic]
```

## 8. Runtime Abstraction

claw-farm supports multiple agent runtimes through the `AgentRuntime` interface in `src/runtimes/`.

```
src/
├── runtimes/
│   ├── interface.ts        ← AgentRuntime interface definition
│   ├── openclaw.ts         ← OpenClaw runtime (~1.5GB, full-featured)
│   ├── picoclaw.ts         ← picoclaw runtime (~20MB, lightweight Go)
│   └── index.ts            ← Runtime resolver (by name)
├── commands/
├── lib/
├── processors/
└── templates/
```

### AgentRuntime Interface

Each runtime implements:
- **scaffoldProject()** — Generate project files (compose, config, workspace)
- **scaffoldInstance()** — Generate per-user instance files
- **getComposeFile()** — Return the compose filename for the runtime
- **getWorkspacePaths()** — Return runtime-specific paths (config, memory, sessions)

### Runtime Selection

```bash
claw-farm init my-agent                          # Default: openclaw
claw-farm init my-agent --runtime openclaw       # Explicit: OpenClaw
claw-farm init my-agent --runtime picoclaw       # Lightweight: picoclaw
```

The `runtime` field is stored in `.claw-farm.json`:
```json
{
  "name": "my-agent",
  "runtime": "picoclaw",
  "proxyMode": "per-instance",
  "processor": "builtin",
  "port": 18789
}
```

### When to Use Each Runtime

| | OpenClaw | picoclaw |
|---|---|---|
| **Image size** | ~1.5GB | ~20MB (75x lighter) |
| **Language** | Node.js | Go |
| **Config** | openclaw.json + policy.yaml | Single config.json |
| **Memory path** | workspace/MEMORY.md | workspace/memory/MEMORY.md |
| **Sessions** | sessions/ (.jsonl) | workspace/sessions/ |
| **Best for** | Full-featured agents, rich plugin ecosystem | Lightweight agents, resource-constrained environments |
| **Multi-agent** | Per-user isolation (spawn) | Built-in roles (not per-user) |

## 9. proxyMode: Shared vs Per-Instance API Proxy

The `--proxy-mode` flag controls how `api-proxy` is deployed across instances.

```bash
claw-farm init my-agent --runtime picoclaw --proxy-mode shared
claw-farm init my-agent --runtime picoclaw --proxy-mode per-instance  # default
```

### per-instance (default)

Each user instance gets its own api-proxy container. This is the same model as OpenClaw.

```
instances/alice/  →  alice-agent + alice-api-proxy
instances/bob/    →  bob-agent   + bob-api-proxy
```

- Full secret isolation per user (each proxy can have different keys)
- Higher resource usage (one proxy per instance)

### shared

All user instances share a single api-proxy container at the project level.

```
api-proxy/        →  shared-api-proxy (one for all)
instances/alice/  →  alice-agent ──→ shared-api-proxy
instances/bob/    →  bob-agent   ──→ shared-api-proxy
```

- Lower resource usage (one proxy total)
- All instances use the same API key
- Cannot isolate per-user secrets (see docs/SECURITY.md)

## 10. picoclaw File Structure

### Single-Instance (picoclaw)

```
my-agent/
│
├── .claw-farm.json                 ← runtime: "picoclaw", proxyMode: "per-instance"
├── .env.example                    ← LLM_PROVIDER + API keys
├── docker-compose.picoclaw.yml     ← picoclaw stack definition
│
├── api-proxy/                      ← Security sidecar (same as OpenClaw)
│   ├── api_proxy.py
│   ├── Dockerfile
│   └── requirements.txt
│
├── picoclaw/                       ← Mounted into picoclaw container
│   ├── config.json                 ← Single config file (LLM + tools + policies)
│   └── workspace/
│       ├── SOUL.md                     Personality & behavior rules
│       ├── memory/
│       │   └── MEMORY.md               Accumulated via conversations
│       ├── sessions/                   Session logs
│       └── skills/                     Custom skills
│
├── raw/                            ← Workspace snapshots
│   └── workspace-snapshots/
├── processed/                      ← Layer 1: disposable, rebuildable
└── logs/                           ← API proxy audit logs
```

### Multi-Instance (picoclaw)

```
dog-agent/
├── .claw-farm.json                    ← runtime: "picoclaw", multiInstance: true
├── api-proxy/                         ← Shared or per-instance (depends on proxyMode)
│
├── template/
│   ├── SOUL.md                            Shared personality
│   ├── AGENTS.md                          Shared behavior rules
│   ├── skills/                            Shared skills
│   ├── USER.template.md                   Per-user placeholders
│   └── config/
│       └── config.json                    picoclaw config (single file)
│
└── instances/
    ├── alice/
    │   ├── docker-compose.picoclaw.yml
    │   ├── picoclaw/
    │   │   ├── config.json                    Copied from template/config/
    │   │   └── workspace/
    │   │       ├── USER.md                    Alice's context
    │   │       ├── memory/
    │   │       │   └── MEMORY.md              Alice's memory
    │   │       └── sessions/                  Alice's sessions
    │   ├── raw/workspace-snapshots/
    │   └── processed/
    │
    └── bob/
        └── ...                                Same structure as alice
```

## 11. picoclaw Container Topology

### Local Development (picoclaw, per-instance proxy)

```
┌──────────────────────────────────────────────────────┐
│                    Docker                             │
│                                                      │
│   ┌─ proxy-net ──────────────────────────────┐       │
│   │                                           │       │
│   │  ┌──────────────┐    ┌──────────────────┐│       │
│   │  │  api-proxy   │    │ picoclaw-gateway ││       │
│   │  │              │◄───│                  ││       │
│   │  │ Holds API    │    │ ~20MB Go binary  ││       │
│   │  │ keys         │    │ NO API keys      ││       │
│   │  │ :8080        │    │ :18789 → host    ││       │
│   │  └──────┬───────┘    └──────────────────┘│       │
│   └─────────┼────────────────────────────────┘       │
│             ▼                                        │
│     LLM API endpoint                                 │
└──────────────────────────────────────────────────────┘
      │
      ▼
  localhost:18789 ──→ Agent interface
```

### Local Development (picoclaw, shared proxy)

```
┌──────────────────────────────────────────────────────────┐
│                         Docker                            │
│                                                          │
│   ┌─ proxy-net ──────────────────────────────────┐       │
│   │                                               │       │
│   │  ┌──────────────┐                             │       │
│   │  │  api-proxy   │  (shared, one for all)      │       │
│   │  │  :8080       │◄──────┬──────────┐          │       │
│   │  └──────┬───────┘       │          │          │       │
│   │         │          ┌────┴───┐ ┌────┴───┐      │       │
│   │         │          │ alice  │ │  bob   │      │       │
│   │         │          │ :18790 │ │ :18791 │      │       │
│   │         │          └────────┘ └────────┘      │       │
│   └─────────┼────────────────────────────────────┘       │
│             ▼                                            │
│     LLM API endpoint                                     │
└──────────────────────────────────────────────────────────┘
```

**Note on picoclaw multi-agent:** picoclaw has a built-in multi-agent feature for defining agent roles (e.g., researcher, writer, reviewer) within a single instance. This is different from claw-farm's multi-instance model which provides per-user isolation. picoclaw's roles run inside one container; claw-farm's instances are separate containers with separate data.
