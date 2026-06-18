import { describe, expect, test } from "bun:test";
import { hermesComposeTemplate, hermesInstanceComposeTemplate } from "../docker-compose.hermes.yml.ts";

describe("hermesComposeTemplate gatewayAllowAllUsers", () => {
  test("defaults to GATEWAY_ALLOW_ALL_USERS: false", () => {
    const compose = hermesComposeTemplate("test-proj", 18790);
    expect(compose).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
    expect(compose).not.toContain('GATEWAY_ALLOW_ALL_USERS: "true"');
  });

  test("explicit false produces GATEWAY_ALLOW_ALL_USERS: false", () => {
    const compose = hermesComposeTemplate("test-proj", 18790, "none", false);
    expect(compose).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
  });

  test("explicit true produces GATEWAY_ALLOW_ALL_USERS: true", () => {
    const compose = hermesComposeTemplate("test-proj", 18790, "none", true);
    expect(compose).toContain('GATEWAY_ALLOW_ALL_USERS: "true"');
  });
});

describe("hermesInstanceComposeTemplate gatewayAllowAllUsers", () => {
  test("defaults to GATEWAY_ALLOW_ALL_USERS: false", () => {
    const compose = hermesInstanceComposeTemplate("test-proj", "user-1", 18790);
    expect(compose).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
    expect(compose).not.toContain('GATEWAY_ALLOW_ALL_USERS: "true"');
  });

  test("explicit false produces GATEWAY_ALLOW_ALL_USERS: false", () => {
    const compose = hermesInstanceComposeTemplate("test-proj", "user-1", 18790, "none", undefined, false);
    expect(compose).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
  });

  test("explicit true produces GATEWAY_ALLOW_ALL_USERS: true", () => {
    const compose = hermesInstanceComposeTemplate("test-proj", "user-1", 18790, "none", undefined, true);
    expect(compose).toContain('GATEWAY_ALLOW_ALL_USERS: "true"');
  });
});

describe("hermes runtime gatewayAllowAllUsers via instanceComposeTemplate", () => {
  test("hermes runtime instanceComposeTemplate passes gatewayAllowAllUsers", async () => {
    const { getRuntime } = await import("../../runtimes/index.ts");
    const runtime = getRuntime("hermes");

    const composeTrue = runtime.instanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", "/runtime/instance", true,
    );
    expect(composeTrue).toContain('GATEWAY_ALLOW_ALL_USERS: "true"');

    const composeFalse = runtime.instanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", "/runtime/instance", false,
    );
    expect(composeFalse).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
    expect(composeFalse).not.toContain('GATEWAY_ALLOW_ALL_USERS: "true"');

    // Default (no arg) should be false
    const composeDefault = runtime.instanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", "/runtime/instance",
    );
    expect(composeDefault).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
  });

  test("hermes runtime composeTemplate passes gatewayAllowAllUsers", async () => {
    const { getRuntime } = await import("../../runtimes/index.ts");
    const runtime = getRuntime("hermes");

    const composeTrue = runtime.composeTemplate("test-proj", 18790, "none", true);
    expect(composeTrue).toContain('GATEWAY_ALLOW_ALL_USERS: "true"');

    const composeFalse = runtime.composeTemplate("test-proj", 18790, "none", false);
    expect(composeFalse).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');

    const composeDefault = runtime.composeTemplate("test-proj", 18790);
    expect(composeDefault).toContain('GATEWAY_ALLOW_ALL_USERS: "false"');
  });
});

describe("hermesInstanceComposeTemplate with weixin sidecar (#159B)", () => {
  test("without sidecar has no weixin-sidecar service", () => {
    const compose = hermesInstanceComposeTemplate("test-proj", "user-1", 18790);
    expect(compose).not.toContain("weixin-sidecar:");
    expect(compose).not.toContain("sidecar-net");
  });

  test("with sidecar includes weixin-sidecar service and sidecar-net", () => {
    const compose = hermesInstanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", undefined, false, true, ".env.weixin", 8787
    );
    expect(compose).toContain("weixin-sidecar:");
    expect(compose).toContain("sidecar-net:");
    expect(compose).toContain("container_name: test-proj-user-1-weixin");
  });

  test("uses pre-built sidecar image (not local build context)", () => {
    const compose = hermesInstanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", undefined, false, true
    );
    expect(compose).toContain("image: clawbay-bay-sidecar-weixin:latest");
    expect(compose).not.toContain("build: ../../claw-sidecar-weixin");
  });

  test("consumes token via env_file (.env.weixin) without overriding in environment", () => {
    const compose = hermesInstanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", undefined, false, true, ".env.weixin"
    );
    expect(compose).toContain("- ./.env.weixin");
    // WEIXIN_BINDING_TOKEN should NOT appear in environment (would override env_file)
    const weixinSection = compose.slice(compose.indexOf("weixin-sidecar:"));
    expect(weixinSection).not.toMatch(/WEIXIN_BINDING_TOKEN:/);
    expect(compose).not.toMatch(/WEIXIN_BINDING_TOKEN=cbt_/);
  });

  test("uses per-instance port mapping", () => {
    const compose = hermesInstanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", undefined, false, true, ".env.weixin", 18887
    );
    expect(compose).toContain("0.0.0.0:18887:8787");
  });

  test("connects to sidecar-gateway via host.docker.internal", () => {
    const compose = hermesInstanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", undefined, false, true
    );
    expect(compose).toContain("SIDECAR_GATEWAY_URL: http://host.docker.internal:3002");
  });

  test("does not contain plaintext token", () => {
    const compose = hermesInstanceComposeTemplate(
      "test-proj", "user-1", 18790, "none", undefined, false, true
    );
    expect(compose).not.toMatch(/cbt_[a-zA-Z0-9_-]{20,}/);
  });

  test("hermes sidecar includes readiness env vars (OPENCLAW_STATE_DIR, SESSION_STORAGE_PATH)", () => {
    const compose = hermesInstanceComposeTemplate(
      "clawbay-hermes", "test-user", 18850, "none", "/tmp/test-hermes", false, true
    );
    expect(compose).toContain("OPENCLAW_STATE_DIR: /data/openclaw");
    expect(compose).toContain("SESSION_STORAGE_PATH: /data/weixin-sessions");
    expect(compose).toContain("WEIXIN_HEALTH_CHECK_URL:");
  });
});
