# Control-plane runtime release consumption (#178-D)

Bay's trusted bridge can supply `runtimeRelease: {id, manifestSha256, images:
{gateway, sidecar}}` with OpenClaw `sidecar.attach`. Farm validates immutable
references and persists the selection with the sidecar spec. It does not verify
approval itself: Bay owns signature verification and approval, and this bridge
must remain inaccessible to end users.

`CLAW_FARM_RUNTIME_RELEASE_REQUIRED=true` rejects attach without a resolved
release; manual image environment variables cannot satisfy that requirement.
Legacy mode is retained for existing deployments until the coordinated rollout.
For catalog-managed instances, lifecycle guards use the persisted pair and still
verify the Farm-generated Compose SHA-256. Attach replay rejects missing or
changed release identity/hash/images. Active legacy instances cannot silently
adopt a catalog release; migration needs a separate explicit workflow.

Validation: 277 tests and typecheck pass. Bridge tests cover legacy and catalog
pairs, persisted selection, idempotency, replacement/omission rejection, Compose
tamper rejection and cleanup. Docker calls are mocked; this is not native runtime
or integrated E2E evidence. Production rollout still requires Bay whole-instance
release authorization, native writer identity and qualified signed artifacts.
