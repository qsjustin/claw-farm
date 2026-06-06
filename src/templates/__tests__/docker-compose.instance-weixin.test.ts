/**
 * #159B Phase 2: Per-instance weixin sidecar compose template tests.
 *
 * Validates that the instance compose template correctly generates
 * a real weixin sidecar service when enableWeixinSidecar is true.
 *
 * Key assertions:
 * - Sidecar service exists and is a REAL consumer (not a dead descriptor)
 * - Token is consumed via env_file ONLY (no environment override)
 * - Per-instance port mapping (not host network_mode)
 * - Bridge network for isolation
 * - Without enableWeixinSidecar, compose is unchanged (backward compatible)
 * - Plaintext token is NEVER written to the compose template itself
 */

import { describe, expect, it } from "bun:test";
import { buildInstanceCompose, instanceComposeTemplate } from "../docker-compose.instance.yml.ts";

describe("Per-instance weixin sidecar compose (Phase 2)", () => {
  const baseOpts = {
    projectName: "clawbay-openclaw",
    userId: "user-1",
    port: 18789,
    proxyMode: "none" as const,
    instanceHostDir: "/runtime/instance",
  };

  describe("enableWeixinSidecar = false (default, backward compatible)", () => {
    it("does not include a weixin-sidecar service", () => {
      const compose = instanceComposeTemplate("clawbay-openclaw", "user-1", 18789, "none", "/runtime/instance");
      expect(compose).not.toContain("weixin-sidecar:");
      expect(compose).not.toContain("claw-sidecar-weixin");
    });

    it("matches the original template output", () => {
      const compose = instanceComposeTemplate("clawbay-openclaw", "user-1", 18789, "none", "/runtime/instance");
      expect(compose).toContain("openclaw-gateway:");
      expect(compose).toContain("container_name: clawbay-openclaw-user-1-openclaw");
      expect(compose).toContain("OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN:?");
    });
  });

  describe("enableWeixinSidecar = true", () => {
    it("includes a weixin-sidecar service", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("weixin-sidecar:");
      expect(compose).toContain("container_name: clawbay-openclaw-user-1-weixin");
    });

    it("uses the claw-sidecar-weixin build context", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("build: ../../claw-sidecar-weixin");
    });

    it("consumes token via env_file ONLY (no environment override)", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      // Must reference the env_file
      expect(compose).toContain("env_file:");
      expect(compose).toContain("- ./.env.weixin");
      // Must NOT have WEIXIN_BINDING_TOKEN in environment (would override env_file)
      const weixinSection = compose.slice(compose.indexOf("weixin-sidecar:"));
      expect(weixinSection).not.toMatch(/WEIXIN_BINDING_TOKEN:/);
      // Must NOT contain a hardcoded token value
      expect(compose).not.toMatch(/WEIXIN_BINDING_TOKEN=cbt_/);
    });

    it("uses bridge network (not host network_mode)", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      const weixinSection = compose.slice(compose.indexOf("weixin-sidecar:"));
      expect(weixinSection).not.toContain("network_mode: host");
      expect(weixinSection).toContain("sidecar-net");
    });

    it("maps per-instance port to avoid conflicts", () => {
      const compose = buildInstanceCompose({
        ...baseOpts,
        enableWeixinSidecar: true,
        weixinSidecarPort: 18887,
      });
      expect(compose).toContain("127.0.0.1:18887:8787");
    });

    it("uses default port 8787 when not specified", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("127.0.0.1:8787:8787");
    });

    it("connects to shared sidecar-gateway via host.docker.internal", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("SIDECAR_GATEWAY_URL: http://host.docker.internal:3002");
    });

    it("connects to shared claw-bay-api via host.docker.internal", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("SIDECAR_CLAW_BAY_API_URL: http://host.docker.internal:3001");
    });

    it("has a healthcheck on /healthz for readiness verification", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("healthcheck:");
      expect(compose).toContain("http://127.0.0.1:8787/healthz");
    });

    it("mounts the instance workspace runtime sidecar data dir", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("/runtime/instance/openclaw/workspace/runtime/sidecar-weixin:/data");
    });

    it("applies security hardening (read_only, no-new-privileges, cap_drop)", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      const weixinSection = compose.slice(compose.indexOf("weixin-sidecar:"));
      expect(weixinSection).toContain("read_only: true");
      expect(weixinSection).toContain("no-new-privileges:true");
      expect(weixinSection).toContain("cap_drop:");
      expect(weixinSection).toContain("- ALL");
    });

    it("respects custom weixinEnvFile path", () => {
      const compose = buildInstanceCompose({
        ...baseOpts,
        enableWeixinSidecar: true,
        weixinEnvFile: "custom-weixin.env",
      });
      expect(compose).toContain("- ./custom-weixin.env");
      expect(compose).not.toContain("- ./.env.weixin");
    });

    it("does not contain plaintext token in any form", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).not.toMatch(/cbt_[a-zA-Z0-9_-]{20,}/);
    });

    it("includes sidecar-net network definition", () => {
      const compose = buildInstanceCompose({ ...baseOpts, enableWeixinSidecar: true });
      expect(compose).toContain("sidecar-net:");
    });
  });

  describe("with proxy mode and weixin sidecar", () => {
    it("includes both api-proxy and weixin-sidecar services", () => {
      const compose = buildInstanceCompose({
        ...baseOpts,
        proxyMode: "per-instance",
        enableWeixinSidecar: true,
      });
      expect(compose).toContain("api-proxy:");
      expect(compose).toContain("weixin-sidecar:");
      expect(compose).toContain("openclaw-gateway:");
    });

    it("weixin-sidecar does not depend on api-proxy (separate concerns)", () => {
      const compose = buildInstanceCompose({
        ...baseOpts,
        proxyMode: "per-instance",
        enableWeixinSidecar: true,
      });
      const weixinSection = compose.slice(
        compose.indexOf("weixin-sidecar:"),
        compose.indexOf("openclaw-gateway:"),
      );
      expect(weixinSection).not.toContain("depends_on:");
    });

    it("includes both proxy-net and sidecar-net", () => {
      const compose = buildInstanceCompose({
        ...baseOpts,
        proxyMode: "per-instance",
        enableWeixinSidecar: true,
      });
      expect(compose).toContain("proxy-net:");
      expect(compose).toContain("sidecar-net:");
    });
  });
});
