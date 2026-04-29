# Bridge Operations

`claw-farm bridge <operation> <json>` is the machine interface used by claw-bay-api. Every operation prints a single JSON response with the shared bridge envelope:

```json
{
  "ok": true,
  "action": "instance.sync",
  "message": "Instance state synchronized.",
  "observedAt": "2026-04-29T00:00:00.000Z",
  "runtimeState": "running",
  "runtimeInstanceKey": "clawbay-prod:user-1",
  "runtimeWorkspaceSlug": "user-1"
}
```

Failure responses use `ok: false`, include `error`, `errorCode`, and `retryable`, and never require callers to parse stderr.

## Instance Lifecycle

| Operation | Required input | Purpose |
|---|---|---|
| `instance.create` | `project`, `userId`, optional `displayName`, `autoStart`, `context` | Creates a managed runtime workspace and optional running instance. |
| `instance.start` | `project` + `userId` or `runtimeInstanceKey` | Starts compose services for the instance. |
| `instance.stop` | `project` + `userId` or `runtimeInstanceKey` | Stops compose services while preserving workspace data. |
| `instance.restart` | `project` + `userId` or `runtimeInstanceKey` | Stops then starts the runtime instance. |
| `instance.delete` | `project` + `userId` or `runtimeInstanceKey` | Stops services and removes the managed workspace. |
| `instance.sync` | `project` + `userId` or `runtimeInstanceKey` | Reads current runtime state and reports it to the platform. |

## Continuity

| Operation | Required input | Output |
|---|---|---|
| `instance.export` | `project`, `userId`, `runtimeWorkspaceSlug`, `exportRoot` | `bundlePath`, `manifestPath`, `checksumPath`, `fileCount`, `sizeBytes`, `bundleChecksum` |
| `instance.import` | `project`, `userId`, `runtimeWorkspaceSlug`, `bundlePath`, `manifestPath` | `restoredFileCount`, `bundleChecksum`, `rebuildRequired` |

Exports include `config`, `skills`, `sessions`, and runtime metadata. `cache` and `tmp` are excluded by default.

## Model Controls

| Operation | Required input | Purpose |
|---|---|---|
| `instance.applyModelControl` | `project`, `userId`, `llm`, `apiKey`, optional `baseUrl`, `model`, `label` | Writes per-instance model configuration into the runtime workspace. |

## Agent Runtime Config

| Operation | Required input | Purpose |
|---|---|---|
| `agent.create` | `project`, `userId`, `agentSlug`, optional `displayName`, `templateCode`, `context` | Creates an agent runtime config under the canonical instance workspace. |
| `agent.updateConfig` | `project`, `userId`, `agentSlug`, `patch` | Updates an existing agent runtime config without changing platform business state. |

## Reusable Fixtures

Bridge fixtures live under `tests/fixtures/{success,errors}`. They are contract examples for both `claw-farm` tests and `claw-bay` adapter tests:

- `tests/fixtures/success/*.json` covers every supported bridge operation listed above.
- `tests/fixtures/errors/*.json` covers every shared bridge `errorCode`.
- Fixtures must not contain host absolute paths. Use workspace-relative paths such as `runtime/agents/assistant/agent.md`.

## Error Codes

| Code | Retry? | Meaning |
|---|:---:|---|
| `adapter-unavailable` | yes | Runtime bridge dependency or environment is unavailable. |
| `invalid-operation` | no | Unknown bridge operation. |
| `invalid-payload` | no | Missing or invalid JSON input. |
| `runtime-missing` | no | Target project or instance does not exist. |
| `runtime-conflict` | no | The requested mutation conflicts with existing runtime state. |
| `runtime-command-failed` | yes | Docker, archive, or runtime command failed. |
| `unknown` | yes | Unexpected bridge failure. |

Retry guidance:

- Retry only `retryable: true` failures.
- `invalid-payload`, `invalid-operation`, and `runtime-missing` require caller-side correction.
- For `runtime-command-failed`, inspect `metadata` where present before automatic retry.
