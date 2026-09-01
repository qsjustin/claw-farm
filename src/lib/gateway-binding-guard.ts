import { readSidecarSpec } from "./sidecar-spec.ts";
import { resolveWeixinRuntimeProfile, type WeixinRuntimeProfile } from "./weixin-runtime-profile.ts";

export type GatewayBindingComposeGuard = {
  allowOverride: boolean;
  runtimeProfile?: WeixinRuntimeProfile;
};

/**
 * Re-read the persisted pair before any lifecycle command that consumes an
 * existing Compose file. A changed/deleted deployment profile must not silently
 * replace a running gateway-binding workload with stock/latest images.
 */
export async function resolveGatewayBindingComposeGuard(instDir: string): Promise<GatewayBindingComposeGuard> {
  const spec = await readSidecarSpec(instDir);
  if (spec?.gatewayBinding !== true) return { allowOverride: true };

  const runtimeProfile = resolveWeixinRuntimeProfile();
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
