import { describe, expect, test } from "bun:test";
import { mintBindingToken } from "../claw-bay-binding-token.ts";

describe("mintBindingToken", () => {
  test("returns error when required config is missing", async () => {
    const result = await mintBindingToken({
      clawBayApiUrl: "",
      adminToken: "token",
      instanceId: "inst-1",
      userId: "user-1",
      sidecarCode: "weixin-auth-sidecar",
    });
    expect(result.ok).toBe(false);
    expect(result.token).toBeNull();
    expect(result.error).toContain("Missing required configuration");
  });

  test("returns error when API returns non-ok status", async () => {
    const result = await mintBindingToken({
      clawBayApiUrl: "http://localhost:1", // unreachable
      adminToken: "token",
      instanceId: "inst-1",
      userId: "user-1",
      sidecarCode: "weixin-auth-sidecar",
    });
    expect(result.ok).toBe(false);
    expect(result.token).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("returns error on network failure", async () => {
    const result = await mintBindingToken({
      clawBayApiUrl: "http://invalid-host-that-does-not-exist:9999",
      adminToken: "token",
      instanceId: "inst-1",
      userId: "user-1",
      sidecarCode: "weixin-auth-sidecar",
    });
    expect(result.ok).toBe(false);
    expect(result.token).toBeNull();
    expect(result.error).toContain("Failed to mint binding token");
  });
});
