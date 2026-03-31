# OpenClaw Security Hardening Guide

> Research as of 2026-03-20. Rationale document for claw-farm's security design.
>
> Korean version: [ko/SECURITY.md](ko/SECURITY.md)

## Sources

- [OpenClaw Official Security Docs](https://docs.openclaw.ai/gateway/security)
- [Nebius: OpenClaw Security Architecture Guide](https://nebius.com/blog/posts/openclaw-security)
- [Snyk: 280+ Leaky Skills — Credential Leak Research](https://snyk.io/blog/openclaw-skills-credential-leaks-research/)
- [Knostic: openclaw-shield (PII/Secret Prevention)](https://www.knostic.ai/blog/openclaw-shield-preventing-secret-leaks-pii-exposure-and-destructive-commands)
- [DEV.to: Complete Privacy & Security Guide 2026](https://dev.to/apilover/how-to-secure-your-openclaw-installation-complete-privacy-security-guide-2026-750)
- [Docker Blog: Run OpenClaw Securely in Docker Sandboxes](https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/)
- [Microsoft Security Blog: Running OpenClaw Safely (2026-02)](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
- [HN Discussion on Docker Security](https://news.ycombinator.com/item?id=46884143)

---

## 1. API Key / Credential Management

### Core Principle
- **The agent must never see the API key**
- Passing keys as env vars allows the agent to read them via `env` or `/proc/self/environ`
- Snyk research: 7.1% of ClawHub skills (283/3,984) have critical credential exposure flaws

### Recommended Architecture: API Proxy Sidecar
```
OpenClaw ──(no key)──→ API Proxy ──(key injection)──→ LLM API
```
- OpenClaw uses `apiBaseUrl: "http://api-proxy:8080"`
- Only the proxy holds API keys, with no external port exposure
- Proxy injects keys and forwards upstream

### Additional Recommendations
- Use a Secret Manager (Vault, AWS SM, 1Password CLI) instead of .env files
- Separate API keys per project with spending limits
- Rotate keys every 90 days
- Run `openclaw security audit` regularly

### claw-farm Implementation
- `api-proxy/` sidecar: FastAPI, key injection, audit logging
- OpenClaw container has NO `GEMINI_API_KEY`
- `openclaw.json` uses `apiKey: "proxied"`

---

## 2. Data Leakage Prevention (PII / Personal Data)

### Threat Model
1. **Outbound leakage**: User personal data (videos, photos, documents) included in LLM prompts
2. **Skill-based leakage**: Malicious/vulnerable skills store keys in MEMORY.md → exfiltration
3. **Log leakage**: Sensitive data persists in session transcripts
4. **LLM response leakage**: Agent includes previously-seen secrets in responses

### Snyk's 4 Leak Patterns
1. **Verbatim Output**: Skill outputs API key directly to chat
2. **Financial Exfil**: Card numbers embedded in curl commands
3. **Log Leakage**: Session files exported without redaction
4. **Plaintext Storage**: Keys stored as plaintext in MEMORY.md

### openclaw-shield 5-Layer Defense
1. **Prompt Guard**: Injects security policies into agent context
2. **Output Scanner**: Redacts secrets/PII from tool output
3. **Tool Blocker**: Blocks dangerous tool calls at host level
4. **Input Audit**: Logs inbound messages + detects secrets
5. **Security Gate**: ALLOWED/DENIED judgment before exec/file-read

### claw-farm Implementation
- `api-proxy` detects outbound PII patterns (SSN, cards, phones, Korean RRN)
- `MAX_PROMPT_SIZE_MB=5` limit (blocks bulk file exfiltration)
- PII auto-redaction (detect → mask as `[REDACTED_TYPE]`)
- LLM response secret scanning (AWS keys, GitHub tokens, card numbers, etc.)
- Audit log records content hash + PII detection flags

---

## 3. Container / Infrastructure Isolation

### Docker Hardening Checklist
- [x] `read_only: true` — read-only container filesystem
- [x] `tmpfs` — /tmp, .cache only as writable (size-limited)
- [x] `cap_drop: ALL` — drop all Linux capabilities
- [x] `security_opt: no-new-privileges` — prevent privilege escalation
- [x] `deploy.resources.limits` — memory/CPU limits
- [x] Non-root user (OpenClaw: node, mem0/proxy: appuser)
- [x] Volume mounts `:ro` (config directory)

### Network Topology
```
                    ┌─ proxy-net (outbound OK) ─┐
  openclaw ────────→│ api-proxy ───────────→ Gemini API
     │              └───────────────────────────┘
     │
     ├─ frontend (internal, no outbound)
     └────────────→ mem0-api
                      │
                    backend (internal)
                      │
                    qdrant
```
- `proxy-net`: Only api-proxy has external access
- `frontend`: OpenClaw ↔ Mem0 only (internal)
- `backend`: Mem0 ↔ Qdrant only (internal)

---

## 4. Network Access Control

### Local Development
- `127.0.0.1` binding (no external access)
- `gateway.bind: "loopback"` default

### Cloud Deployment
- `gateway.auth.mode: "token"` required
- Nginx reverse proxy + TLS + Basic Auth
- IP allowlist or Tailscale VPN
- `dmPolicy: "pairing"` (blocks unknown senders)

### Never Do This
- Bind to `0.0.0.0` without auth token
- Set `dmPolicy: "open"` (unlimited inbound)
- Expose dashboard publicly

---

## 5. Tool Access Control

### Principle: Allowlist-first
```yaml
tools:
  filesystem:
    allow: [/home/node/.openclaw/workspace/**]
    deny: [/etc/**, /proc/**, /sys/**]
  http:
    deny: ["*"]  # deny all by default
  shell:
    enabled: false
  code_execution:
    sandbox: true
    timeout_seconds: 30
```

### Dangerous Tools (require explicit control)
- `exec` / `process`: Command execution
- `browser`: Browser automation
- `web_fetch` / `web_search`: External content
- `gateway`: Config changes
- `cron`: Scheduled jobs

### ClawHub Skill Security
- Review source code before installing any skill
- Audit with `mcp-scan`
- Test in sandbox first
- 2026-01 ClawHavoc campaign: hundreds of malicious skills discovered (keyloggers, API key theft)

---

## 6. Auditing / Monitoring

### Required Audit Items
- All tool calls (timestamp + user + action)
- LLM API requests (content hash, size, response code, elapsed time)
- PII detection events
- Failed authentication attempts

### Commands
```bash
openclaw security audit              # Basic audit
openclaw security audit --deep       # Includes live gateway probe
openclaw security audit --fix        # Auto-correct some issues
openclaw security audit --json       # Machine-readable output
```

### Log Management
- JSON/JSONL format
- Rotate at 100MB, retain max 10 files
- Redact sensitive data before retention
- Auto-delete logs older than 30 days

---

## 7. Incident Response

### Immediate Containment
1. Stop gateway process
2. Set `gateway.bind: "loopback"`
3. Disable Tailscale Funnel/Serve
4. Set risky channels to `dmPolicy: "disabled"`

### Key Rotation (on secret exposure)
1. `gateway.auth.token`
2. LLM API keys (Gemini, OpenAI, etc.)
3. Channel credentials (Slack, Discord, etc.)
4. Encrypted secrets in `secrets.json`

### Post-Incident Analysis
1. Review `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
2. Examine session transcripts
3. Check config change history
4. Re-run `openclaw security audit --deep`

---

## 8. proxyMode Security Implications

claw-farm supports two api-proxy deployment modes via the `--proxy-mode` flag. The choice has direct security implications.

### per-instance (default)

Each user instance has its own api-proxy container.

- **Secret isolation:** Each proxy can hold different API keys. User A's key is never accessible to User B's agent container.
- **Audit isolation:** Each proxy writes its own audit log. Per-user forensics are straightforward.
- **Blast radius:** A compromised proxy only exposes one user's credentials.
- **Same security model as OpenClaw's default architecture.**

### shared

All user instances share a single api-proxy container at the project level.

- **No per-user secret isolation:** All instances use the same API key. If one agent is compromised, the shared key is exposed to all.
- **Shared audit log:** All users' requests appear in the same log. Per-user attribution requires parsing request metadata.
- **Larger blast radius:** A compromised shared proxy exposes the key used by all instances.
- **Use only when:** All instances are trusted equally (e.g., same organization, same trust level) and resource efficiency is more important than per-user key isolation.

### Container Isolation (unchanged by proxyMode)

Regardless of proxyMode, each user instance runs in its own container with:
- Separate filesystem (read_only, tmpfs)
- Separate network namespace
- Separate memory/CPU limits
- No cross-instance volume sharing

This applies to both OpenClaw and picoclaw runtimes. The picoclaw runtime uses per-user containers in the same isolation pattern as OpenClaw, despite picoclaw's smaller footprint (~20MB vs ~1.5GB).
