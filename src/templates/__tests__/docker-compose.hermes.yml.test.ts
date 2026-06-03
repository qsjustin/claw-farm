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
