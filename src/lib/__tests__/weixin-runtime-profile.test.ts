import { describe, expect, it } from "bun:test";

import { resolveWeixinRuntimeProfile } from "../weixin-runtime-profile.ts";

const sidecarImage = "registry.example.test/clawbay-weixin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gatewayImage = "registry.example.test/openclaw@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("Weixin gateway-binding runtime profile", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(resolveWeixinRuntimeProfile({})).toEqual({ gatewayBinding: false });
    expect(resolveWeixinRuntimeProfile({ CLAW_FARM_WEIXIN_GATEWAY_BINDING: "false" })).toEqual({ gatewayBinding: false });
  });

  it("requires an immutable sidecar/gateway image pair", () => {
    expect(() => resolveWeixinRuntimeProfile({
      CLAW_FARM_WEIXIN_GATEWAY_BINDING: "true",
      CLAW_FARM_WEIXIN_SIDECAR_IMAGE: sidecarImage,
    })).toThrow("CLAW_FARM_OPENCLAW_GATEWAY_IMAGE is required");

    expect(() => resolveWeixinRuntimeProfile({
      CLAW_FARM_WEIXIN_GATEWAY_BINDING: "true",
      CLAW_FARM_WEIXIN_SIDECAR_IMAGE: "clawbay-weixin:latest",
      CLAW_FARM_OPENCLAW_GATEWAY_IMAGE: gatewayImage,
    })).toThrow("immutable image digest");
  });

  it("returns only validated digest-pinned images", () => {
    expect(resolveWeixinRuntimeProfile({
      CLAW_FARM_WEIXIN_GATEWAY_BINDING: "true",
      CLAW_FARM_WEIXIN_SIDECAR_IMAGE: sidecarImage,
      CLAW_FARM_OPENCLAW_GATEWAY_IMAGE: gatewayImage,
    })).toEqual({
      gatewayBinding: true,
      sidecarImage,
      gatewayImage,
    });
  });
});

const release = { id: "release-1", manifestSha256: "c".repeat(64), images: { gateway: gatewayImage, sidecar: sidecarImage } };
it("consumes the Bay resolved pair independently of manual image environment", () => {
  expect(resolveWeixinRuntimeProfile({ CLAW_FARM_OPENCLAW_GATEWAY_IMAGE: "malicious:latest" }, release)).toEqual({ gatewayBinding: true, runtimeRelease: release, gatewayImage, sidecarImage });
});
it("required release mode has no legacy environment fallback", () => {
  expect(() => resolveWeixinRuntimeProfile({ CLAW_FARM_RUNTIME_RELEASE_REQUIRED: "true", CLAW_FARM_WEIXIN_GATEWAY_BINDING: "true", CLAW_FARM_OPENCLAW_GATEWAY_IMAGE: gatewayImage, CLAW_FARM_WEIXIN_SIDECAR_IMAGE: sidecarImage })).toThrow("control-plane runtime release is required");
});
it("rejects approval claims, missing hashes and mutable resolved images", () => {
  for (const invalid of [{ ...release, approved: true }, { ...release, manifestSha256: "" }, { ...release, images: { ...release.images, gateway: "openclaw:latest" } }, null]) {
    expect(() => resolveWeixinRuntimeProfile({}, invalid)).toThrow("invalid resolved runtime release");
  }
});
