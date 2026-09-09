import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSidecarSpec } from "./sidecar-spec.ts";
import { resolveWeixinRuntimeProfile, type WeixinRuntimeProfile } from "./weixin-runtime-profile.ts";

export type GatewayBindingComposeGuard = {
  allowOverride: boolean;
  runtimeProfile?: WeixinRuntimeProfile;
};

export async function hashGatewayBindingCompose(instDir: string): Promise<string> {
  const contents = await readFile(join(instDir, "docker-compose.openclaw.yml"), "utf8").catch((error) => {
    throw new Error(`gateway-binding Compose file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  });
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * A paired gateway/sidecar instance only runs the exact Compose file Farm
 * generated during attach.  A mode-only check is not enough: the instance
 * directory is operational data and a changed main file could otherwise add
 * mounts or replace the image without using an override file.
 */
export async function assertGatewayBindingComposeIntegrity(instDir: string): Promise<void> {
  const spec = await readSidecarSpec(instDir);
  if (spec?.gatewayBinding !== true) return;
  const actual = await hashGatewayBindingCompose(instDir);
  if (actual !== spec.gatewayBindingComposeSha256) {
    throw new Error("gateway-binding Compose file does not match the Farm-generated immutable digest");
  }
}

/**
 * Re-read the persisted pair before any lifecycle command that consumes an
 * existing Compose file. A changed/deleted deployment profile must not silently
 * replace a running gateway-binding workload with stock/latest images.
 */
export async function resolveGatewayBindingComposeGuard(instDir: string): Promise<GatewayBindingComposeGuard> {
  const spec = await readSidecarSpec(instDir);
  if (spec?.gatewayBinding !== true) return { allowOverride: true };

  await assertGatewayBindingComposeIntegrity(instDir);

  const runtimeProfile = spec.runtimeRelease
    ? resolveWeixinRuntimeProfile({}, spec.runtimeRelease)
    : resolveWeixinRuntimeProfile();
  if (
    !runtimeProfile.gatewayBinding
    || runtimeProfile.sidecarImage !== spec.gatewayBindingSidecarImage
    || runtimeProfile.gatewayImage !== spec.gatewayBindingGatewayImage
  ) {
    throw new Error("gateway-binding runtime profile does not match the instance's persisted immutable image pair");
  }
  return { allowOverride: false, runtimeProfile };
}

/** Upgrade/runtime migration must have an explicit profile-aware implementation. */
export async function assertNoGatewayBindingUpgrade(instDir: string): Promise<void> {
  const spec = await readSidecarSpec(instDir);
  if (spec?.gatewayBinding === true) {
    throw new Error("operation is blocked for an active gateway-binding instance; use a profile-aware runtime upgrade workflow");
  }
}

/** Require the Bay-resolved selection before start/restart can touch containers. */
export async function assertGatewayBindingReleaseAuthorization(instDir: string, release: unknown): Promise<void> {
  const spec = await readSidecarSpec(instDir);
  if (!spec?.runtimeRelease) {
    if (release !== undefined) throw new Error("runtime release is not pinned in the instance spec");
    return;
  }
  const requested = resolveWeixinRuntimeProfile({}, release).runtimeRelease;
  const pinned = spec.runtimeRelease;
  if (!requested || requested.id !== pinned.id || requested.manifestSha256 !== pinned.manifestSha256
    || requested.images.gateway !== pinned.images.gateway || requested.images.sidecar !== pinned.images.sidecar) {
    throw new Error("runtime release authorization does not match the persisted instance release");
  }
  await assertGatewayBindingComposeIntegrity(instDir);
}
