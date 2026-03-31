# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.3.0] — 2026-03-31

### Added
- **picoclaw runtime support** — lightweight Go-based agent runtime (~20MB vs OpenClaw's ~1.5GB per instance)
  - `--runtime picoclaw` flag for `init` command
  - picoclaw Docker compose templates with security hardening (read_only, cap_drop ALL, no-new-privileges)
  - picoclaw config.json template with api-proxy routing
  - Per-user container isolation (same security model as OpenClaw)
- **Runtime abstraction layer** (`src/runtimes/`) — AgentRuntime interface enabling pluggable runtimes
  - OpenClaw runtime (extracted from existing code, no behavior change)
  - picoclaw runtime (new)
- **`--proxy-mode` option** — control api-proxy sharing strategy
  - `per-instance` (default for OpenClaw): each user gets own api-proxy
  - `shared` (default for picoclaw): all users share one api-proxy (10x resource savings)
  - Hub-and-spoke network topology for cross-tenant isolation in shared mode
- **Runtime column** in `claw-farm list` output
- **picoclaw support** in `cloud:compose` command
- Runtime-aware `memory:rebuild`, `upgrade`, and workspace snapshot commands

### Changed
- `init` command now accepts `--runtime` and `--proxy-mode` flags
- HELP text updated to reflect multi-runtime support
- Title changed from "Multi OpenClaw Instance Manager" to "Multi Agent Instance Manager"

### Fixed
- N/A (new feature)

---

## [0.2.0] — Previous

- Initial multi-instance support, mem0 processor, LLM provider selection
