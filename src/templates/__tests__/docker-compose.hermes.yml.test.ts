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
