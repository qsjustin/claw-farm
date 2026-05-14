# claw-farm

**Deploy one AI agent per user, securely.** The infrastructure toolkit for agent-per-user services — so you build the agent, not the plumbing.

```
Your Service ──→ claw-farm ──→ [User A's Agent] ──→ LLM API
                               [User B's Agent] ──→ (API keys isolated,
                               [User C's Agent]      PII redacted,
                               [  ...N users  ]      secrets scanned)
```

## The Problem

Building a service where each user gets their own AI agent? You'll need:
- Per-user isolated containers (Docker networking, ports, volumes)
- API key proxying (agent must never see raw keys)
- PII auto-redaction on outbound LLM calls
- Secret scanning on inbound LLM responses
- Persistent memory per user (immutable raw data + rebuildable index)
- Template sharing across users (personality, skills, config)
- Scaffolding, deployment, upgrade tooling

That's weeks of boilerplate before you write a single line of agent logic.

## The Solution

```bash
claw-farm init my-agent --multi
claw-farm spawn my-agent --user alice
claw-farm spawn my-agent --user bob
# Done. Two isolated agents, secured, with persistent memory.
```

**CLI** to scaffold & manage. **SDK** to integrate security into your own server.

## Install

```bash
# Requires Bun (https://bun.sh) and Docker
git clone https://github.com/PermissionLabs/claw-farm.git
cd claw-farm && bun install

echo 'alias claw-farm="bun run ~/path/to/claw-farm/src/index.ts"' >> ~/.zshrc
source ~/.zshrc
```

> **npm publish is planned** — `bun install -g @permissionlabs/claw-farm` will work once published.

## Quick Start

```bash
# Single agent (OpenClaw default)
claw-farm init my-agent
cp .env.example .env && vi .env   # Add GEMINI_API_KEY
claw-farm up my-agent
open http://localhost:18789

# Multi-user (agent per user)
claw-farm init my-agent --multi
claw-farm spawn my-agent --user alice --context name=Poppy breed=Maltese
claw-farm spawn my-agent --user bob --context name=Max breed=Golden
claw-farm instances my-agent

# Service runtime: Hermes API server
claw-farm init hermes-agent --runtime hermes --proxy-mode none
cp .env.example .env && vi .env   # Set API_SERVER_KEY and provider keys
claw-farm up hermes-agent
curl -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:18789/health
```

See [Getting Started Guide](docs/getting-started.md) for the full walkthrough.

## Commands

| Command | Description |
|---------|-------------|
| `init <name>` | Scaffold agent project (`--multi`, `--runtime picoclaw|hermes`, `--proxy-mode none`, `--processor mem0`, `--llm anthropic`) |
| `up [name\|--all]` | Start containers (`--user <id>` for specific instance) |
| `down [name\|--all]` | Stop containers |
| `spawn <project> --user <id>` | Create and start per-user instance |
| `despawn <project> --user <id>` | Stop and remove instance |
| `instances <project>` | List all instances |
| `list` | Show all projects + status |
| `upgrade [name]` | Re-generate templates (`--force-policy` to overwrite policy.yaml) |
| `memory:rebuild [name]` | Rebuild Layer 1 from raw data |
| `migrate-runtime <project> --to <rt>` | Switch runtime (openclaw/picoclaw; service-runtime migration is managed through registry/lifecycle contracts) |
| `cloud:compose [outfile]` | Generate cloud deployment compose |

## Runtime Support

`claw-farm` now manages three runtime families:

| Runtime | Purpose | Lifecycle support | Data policy |
|---------|---------|-------------------|-------------|
| `openclaw` | Full OpenClaw service runtime | `init`, `up`, `down`, `spawn`, `despawn`, registry sync | Existing behavior: data is removed on delete unless `--keep-data` is used |
| `picoclaw` | Lightweight Go runtime | Existing lightweight runtime lifecycle | Existing behavior |
| `hermes` | Hermes Agent API server (`nousresearch/hermes-agent`) | `init`, `up`, `down`, `spawn`, `despawn`, `status`, registry sync, multi-instance smoke tested | Data under `hermes/` is retained by default; physical deletion requires explicit `--delete-data` |

Hermes exposes API port `8642` inside the container. Generated compose files bind the host port to `127.0.0.1` and require `API_SERVER_KEY`; there is no default production key. Put provider API keys and `API_SERVER_KEY` in the generated `.env` or per-instance `instance.env`, not in runtime config JSON.

`~/.claw-farm/runtime-instances.json` tracks service runtime instances for ClawBay integration. The registry stores logical refs such as `endpointRef`, `apiKeyRef`, `dataVolumeRef`, and `workspaceRef`; it must not store host absolute paths or raw secrets.

## SDK (Security Modules)

For projects with their own server (`proxyMode: "none"`), import the same security guards as TypeScript:

```typescript
import {
  createLlmProxy, gemini, piiRedactor, secretScanner, auditLogger,
} from "@permissionlabs/claw-farm/security";

const { proxy } = createLlmProxy({
  provider: gemini({ apiKey: process.env.GEMINI_API_KEY! }),
  pipeline: [
    piiRedactor({ mode: "redact" }),
    myCustomMiddleware(),          // your app-specific logic
    secretScanner(),
    auditLogger({ path: "/logs/audit.jsonl" }),
  ],
});
```

Each module works standalone or as composable middleware. See [SDK Guide](docs/sdk-guide.md) for full reference.

## Documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [Getting Started](docs/getting-started.md) | Humans | Zero to production walkthrough |
| [SDK Guide](docs/sdk-guide.md) | Humans + Agents | SDK integration, API reference, migration guide |
| [Agent Integration](docs/agent-integration.md) | AI Agents | File rules, paths, editability, security constraints |
| [Architecture](docs/architecture.md) | Humans + Agents | Full diagrams, container topology, data flow |
| [Workspace Layout](docs/workspace-layout.md) | Humans + Agents | Canonical per-instance workspace directories for bridge and backup flows |
| [Bridge Operations](docs/bridge-operations.md) | Humans + Agents | Machine bridge operations, response envelope, retry guidance, and reusable fixtures |
| [Security](docs/security.md) | Humans | Threat model, hardening checklist |
| [Korean docs](docs/ko/) | Humans | Korean translations |

## ClawBay Bridge Fixtures

`tests/fixtures/` contains reusable JSON examples for the ClawBay bridge contract. Success fixtures cover each supported operation (`instance.*`, `agent.*`) and error fixtures cover every shared bridge error code. Keep these fixtures path-safe and free of host-specific absolute paths so `claw-bay` adapter tests can consume them directly.

## License

MIT — [PermissionLabs](https://github.com/PermissionLabs)
