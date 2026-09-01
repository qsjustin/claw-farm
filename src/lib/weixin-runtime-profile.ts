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
  sidecarImage?: string;
  gatewayImage?: string;
};

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
): WeixinRuntimeProfile {
  if (env.CLAW_FARM_WEIXIN_GATEWAY_BINDING?.trim().toLowerCase() !== "true") {
    return { gatewayBinding: false };
  }

  return {
    gatewayBinding: true,
    sidecarImage: requiredDigestImage(env, "CLAW_FARM_WEIXIN_SIDECAR_IMAGE"),
    gatewayImage: requiredDigestImage(env, "CLAW_FARM_OPENCLAW_GATEWAY_IMAGE"),
  };
}
