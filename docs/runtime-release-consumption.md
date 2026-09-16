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
or integrated E2E evidence. A dev-candidate signed pair now exists in Bay, but
Farm host pulls and instance lifecycle execution against that private pair are
still separate acceptance gates. The follow-up adds Bay whole-instance release
authorization.

Private registry pulls are a deployment prerequisite. Farm invokes Docker Compose
through the host Docker client, inheriting the Farm process environment; the host
must therefore provide a Docker credential configuration with read access to the
approved private GHCR packages, for example by mounting a secret-backed Docker
config and setting `DOCKER_CONFIG` for the Farm process. Do not use the CI
publisher identity as the host pull credential. A dev preflight on 2026-09-16
confirmed that the current local GitHub token lacks the required package-read
scope, so real Farm pull evidence is still blocked until that credential is
provided.

Whole-instance start/restart now require the resolved pair to match the pinned
release and verify Compose integrity before touching containers. Existing paired
instances cannot be recreated through instance.create/restore. Missing/mismatched
authorization tests assert that no Docker command executes. Stop is unaffected
by catalog availability. Farm trusts the Bay bridge rather than accepting a
standalone approval claim; host CLI access remains outside the end-user boundary.
