/**
 * Validated runtime selection for the OpenClaw gateway-binding profile.
 *
 * Compose is rendered from these resolved values, rather than interpolating
 * environment variables when Docker Compose executes. That prevents a caller
 * from redirecting an instance to an arbitrary image after Farm has accepted
 * the lifecycle operation.
 */

export type WeixinRuntimeProfile = {
  gatewayBinding: boolean;
  runtimeRelease?: ResolvedRuntimeRelease;
  sidecarImage?: string;
  gatewayImage?: string;
};

/** Authenticated Bay bridge input, never a user-supplied approval claim. */
export type ResolvedRuntimeRelease = {
  id: string;
  manifestSha256: string;
  images: { gateway: string; sidecar: string };
};

export function parseResolvedRuntimeRelease(value: unknown): ResolvedRuntimeRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid resolved runtime release");
  const row = value as Record<string, unknown>;
  const images = row.images as Record<string, unknown> | undefined;
  if (Object.keys(row).sort().join(",") !== "id,images,manifestSha256"
    || typeof row.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)
    || typeof row.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.manifestSha256)
    || !images || typeof images !== "object" || Array.isArray(images)
    || Object.keys(images).sort().join(",") !== "gateway,sidecar"
    || typeof images.gateway !== "string" || typeof images.sidecar !== "string"
    || !isImmutableImageDigestReference(images.gateway) || !isImmutableImageDigestReference(images.sidecar)) {
    throw new Error("invalid resolved runtime release");
  }
  return { id: row.id, manifestSha256: row.manifestSha256, images: { gateway: images.gateway, sidecar: images.sidecar } };
}

const DIGEST_IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9][a-z0-9._-]{0,127})?@sha256:[a-f0-9]{64}$/;

export function isImmutableImageDigestReference(value: string): boolean {
  return DIGEST_IMAGE_REF.test(value);
}

function requiredDigestImage(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required when CLAW_FARM_WEIXIN_GATEWAY_BINDING=true`);
  }
  if (!isImmutableImageDigestReference(value)) {
    throw new Error(`${key} must be an immutable image digest reference`);
  }
  return value;
}

export function resolveWeixinRuntimeProfile(
  env: Record<string, string | undefined> = process.env,
  release?: unknown,
): WeixinRuntimeProfile {
  if (release !== undefined) {
    const runtimeRelease = parseResolvedRuntimeRelease(release);
    return { gatewayBinding: true, runtimeRelease, gatewayImage: runtimeRelease.images.gateway, sidecarImage: runtimeRelease.images.sidecar };
  }
  if (env.CLAW_FARM_RUNTIME_RELEASE_REQUIRED === "true") throw new Error("control-plane runtime release is required");
  if (env.CLAW_FARM_WEIXIN_GATEWAY_BINDING?.trim().toLowerCase() !== "true") {
    return { gatewayBinding: false };
  }

  return {
    gatewayBinding: true,
    sidecarImage: requiredDigestImage(env, "CLAW_FARM_WEIXIN_SIDECAR_IMAGE"),
    gatewayImage: requiredDigestImage(env, "CLAW_FARM_OPENCLAW_GATEWAY_IMAGE"),
  };
}
