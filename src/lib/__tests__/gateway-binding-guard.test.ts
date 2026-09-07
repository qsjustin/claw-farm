import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSidecarSpec } from "../sidecar-spec.ts";
import { assertNoGatewayBindingUpgrade, resolveGatewayBindingComposeGuard } from "../gateway-binding-guard.ts";

const sidecarImage = "registry.example.test/clawbay-weixin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gatewayImage = "registry.example.test/openclaw@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const composeDigest = "fa6ccea1ca4e3a031d9e99f25cc05db803aa9bac642c000ddab14f6d9da54b52";

describe("gateway-binding lifecycle guard", () => {
  it("uses the persisted immutable pair and rejects override files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-gateway-guard-"));
    const saved = {
      enabled: process.env.CLAW_FARM_WEIXIN_GATEWAY_BINDING,
      sidecar: process.env.CLAW_FARM_WEIXIN_SIDECAR_IMAGE,
      gateway: process.env.CLAW_FARM_OPENCLAW_GATEWAY_IMAGE,
    };
    try {
      await writeFile(join(dir, "docker-compose.openclaw.yml"), "services: {}\n");
      await writeSidecarSpec(dir, {
        schemaVersion: 2,
        enabled: true,
        serviceName: "weixin-sidecar",
        envFile: ".env.weixin",
        port: 8787,
        composeProject: "test-project-user",
        managedInstanceId: "sri-1",
        bindingId: "binding-1",
        operationId: "op-1",
        targetAttachmentVersion: 1,
        targetConfigVersion: 1,
        desiredAttachmentState: "attached",
        gatewayBinding: true,
        gatewayBindingSidecarImage: sidecarImage,
        gatewayBindingGatewayImage: gatewayImage,
        gatewayBindingComposeSha256: composeDigest,
        updatedAt: new Date().toISOString(),
      });
      process.env.CLAW_FARM_WEIXIN_GATEWAY_BINDING = "true";
      process.env.CLAW_FARM_WEIXIN_SIDECAR_IMAGE = sidecarImage;
      process.env.CLAW_FARM_OPENCLAW_GATEWAY_IMAGE = gatewayImage;
      await expect(resolveGatewayBindingComposeGuard(dir)).resolves.toMatchObject({ allowOverride: false });
      await expect(assertNoGatewayBindingUpgrade(dir)).rejects.toThrow("blocked");

      await writeFile(join(dir, "docker-compose.openclaw.yml"), "services:\n  attacker:\n    image: untrusted\n");
      await expect(resolveGatewayBindingComposeGuard(dir)).rejects.toThrow("immutable digest");

      delete process.env.CLAW_FARM_WEIXIN_GATEWAY_BINDING;
      await expect(resolveGatewayBindingComposeGuard(dir)).rejects.toThrow("does not match");
    } finally {
      if (saved.enabled === undefined) delete process.env.CLAW_FARM_WEIXIN_GATEWAY_BINDING;
      else process.env.CLAW_FARM_WEIXIN_GATEWAY_BINDING = saved.enabled;
      if (saved.sidecar === undefined) delete process.env.CLAW_FARM_WEIXIN_SIDECAR_IMAGE;
      else process.env.CLAW_FARM_WEIXIN_SIDECAR_IMAGE = saved.sidecar;
      if (saved.gateway === undefined) delete process.env.CLAW_FARM_OPENCLAW_GATEWAY_IMAGE;
      else process.env.CLAW_FARM_OPENCLAW_GATEWAY_IMAGE = saved.gateway;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
