---
name: claw-farm-code
description: Use this skill when working inside a project managed by claw-farm — editing agent config, SOUL.md, memory, skills, docker-compose, or understanding the file structure. Triggers on .claw-farm.json, SOUL.md, MEMORY.md, openclaw.json, config.json, policy.yaml, api-proxy, workspace keywords.
user-invocable: true
argument-hint: "[topic]"
---

# Working Inside a claw-farm Project

This skill helps you navigate and modify projects managed by claw-farm.

## Detecting a claw-farm Project

Look for `.claw-farm.json` in the project root:
```json
{
  "name": "project-name",
  "runtime": "openclaw" | "picoclaw",
  "proxyMode": "per-instance" | "shared",
  "processor": "builtin" | "mem0",
  "port": 18789,
  "multiInstance": true,
  "llm": "gemini" | "anthropic" | "openai-compat"
}
```
Check `runtime` and `proxyMode` to determine which paths and patterns to use.

## File Map — Single Instance

### openclaw runtime
```
project/
  .claw-farm.json           # Project config (read first!)
  .env                      # API keys (NEVER commit)
  docker-compose.openclaw.yml
  api-proxy/
    api_proxy.py            # Security proxy (PII redaction + key injection)
  openclaw/
    openclaw.json           # LLM model + plugin config
    policy.yaml             # Tool access restrictions
    workspace/
      SOUL.md               # Agent personality — EDIT THIS
      MEMORY.md             # Agent memory — auto-updated
      skills/               # Custom skills — ADD HERE
    sessions/               # Immutable logs — NEVER TOUCH
    logs/                   # Audit logs
  raw/                      # Layer 0 (immutable snapshots)
  processed/                # Layer 1 (rebuildable)
```

### picoclaw runtime
```
project/
  .claw-farm.json
  .env
  docker-compose.picoclaw.yml
  api-proxy/
    api_proxy.py
  picoclaw/
    config.json             # Single config (LLM + tools + policy)
    workspace/
      SOUL.md               # Agent personality — EDIT THIS
      memory/
        MEMORY.md           # Agent memory — auto-updated
      skills/               # Custom skills — ADD HERE
      sessions/             # Session logs
      state/                # Runtime state
```

## File Map — Multi Instance

```
project/
  .claw-farm.json
  template/
    SOUL.md                 # Shared personality (all instances inherit)
    AGENTS.md               # Shared behavior rules
    USER.template.md        # Placeholder template (filled at spawn)
    skills/                 # Shared skills
    config/
      openclaw.json | config.json
      policy.yaml           # openclaw only
  instances/
    <user-id>/
      docker-compose.*.yml
      openclaw/ | picoclaw/
        workspace/
          USER.md           # Per-user context (filled from template)
          MEMORY.md         # Per-user memory (isolated)
          skills/           # Copied from template
        sessions/           # Per-user logs — NEVER TOUCH
      raw/, processed/, logs/
```

## What You Can Safely Edit

| File | Safe? | Notes |
|------|-------|-------|
| `SOUL.md` | YES | Agent personality, behavior rules |
| `AGENTS.md` | YES | Shared agent behavior (multi-instance) |
| `skills/` | YES | Add custom skills |
| `USER.md` | YES | Per-user context |
| `USER.template.md` | YES | Template with `{{placeholder}}` syntax |
| `MEMORY.md` | CAREFUL | Agent auto-updates this; manual edits may be overwritten |
| `openclaw.json` / `config.json` | ASK USER | LLM model, plugins, tools config |
| `policy.yaml` | ASK USER | Tool access restrictions |
| `api_proxy.py` | ASK USER | Security proxy logic |
| `docker-compose.*.yml` | ASK USER | Container orchestration |
| `sessions/` | NEVER | Immutable Layer 0 data |
| `.env` | NEVER COMMIT | Contains API keys |

## Security Rules

1. **API keys are NOT in your environment.** They live in the api-proxy container only.
2. **Outbound requests are PII-filtered.** Korean RRN/phone, US SSN/phone, credit cards, emails, API keys, JWTs — all auto-redacted.
3. **LLM responses are secret-scanned.** API keys or tokens in responses are stripped.
4. **sessions/ is sacred.** Layer 0 is append-only, never deleted.
5. **processed/ is disposable.** Layer 1 can be wiped and rebuilt with `claw-farm memory:rebuild`.

## Memory Architecture

```
Layer 0 (raw/)                    Layer 1 (processed/)
  workspace-snapshots/              MEMORY.md (rebuilt)
    <timestamp>/                    embeddings/ (if mem0)
      MEMORY.md (frozen)
      SOUL.md (frozen)
  sessions/
    *.jsonl (append-only)

         rebuild: claw-farm memory:rebuild
```

- **Layer 0**: Immutable. Snapshots taken on `up`/`down`. Session logs appended.
- **Layer 1**: Rebuilt anytime from Layer 0. Safe to delete.

## Config Merging Behavior

When `claw-farm upgrade` runs:
- Template values = base
- Your existing config values = override (preserved)
- User customizations (controlUi, custom models) are kept
- API keys are forced to proxy sentinels (security)

To persist docker-compose customizations, use `docker-compose.override.yml`.

## Common Patterns

### Adding a new skill
```bash
# Single instance
mkdir -p openclaw/workspace/skills/my-skill
echo "skill content" > openclaw/workspace/skills/my-skill/index.md

# Multi-instance (shared)
mkdir -p template/skills/my-skill
echo "skill content" > template/skills/my-skill/index.md
```

### Changing LLM provider
Edit `.env` with the new key, then update `openclaw.json` or `config.json` model field. The api-proxy routes to the provider specified in `.env`.

### Viewing agent logs
```bash
docker compose -f docker-compose.openclaw.yml logs -f
# or for specific instance:
docker compose -f instances/<user>/docker-compose.openclaw.yml logs -f
```

### Checking proxy audit trail
```bash
cat logs/api-proxy-audit.jsonl | jq .
```

## Proxy Mode Details

### per-instance (default for openclaw)
Each instance has its own api-proxy container. Secrets are isolated. Good for multi-tenant with different API keys per user.

### shared (default for picoclaw)
One api-proxy serves all instances via hub-and-spoke Docker networking. The proxy connects to each instance's network. Same API key for all. Lighter resource usage.

## When You Change Architecture

**You MUST update `docs/ARCHITECTURE.md` first**, then sync:
- `docs/ko/ARCHITECTURE.md` (Korean translation)
- `CLAUDE.md` (conventions)
- `README.md` (user guide)
- `src/index.ts` HELP text (if adding commands)
