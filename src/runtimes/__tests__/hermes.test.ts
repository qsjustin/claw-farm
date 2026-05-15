import { describe, expect, it } from "bun:test";
import { getRuntime } from "../index.ts";

describe("hermes runtime", () => {
  it("registers hermes as an API server runtime", () => {
    const runtime = getRuntime("hermes");

    expect(runtime.name).toBe("hermes");
    expect(runtime.gatewayPort).toBe(8642);
    expect(runtime.containerMountPath).toBe("/opt/data");
    expect(runtime.defaultProxyMode).toBe("none");
  });

  it("renders a per-instance compose template with isolated /opt/data", () => {
    const runtime = getRuntime("hermes");
    const compose = runtime.instanceComposeTemplate("clawbay", "alice", 28642, "none");

    expect(compose).toContain("image: nousresearch/hermes-agent:latest");
    expect(compose).toContain('127.0.0.1:28642:8642');
    expect(compose).toContain("- ./hermes:/opt/data");
    expect(compose).toContain("- ./.env.model");
    expect(compose).toContain("API_SERVER_ENABLED");
    expect(compose).toContain("API_SERVER_KEY: ${API_SERVER_KEY:?");
    expect(compose).not.toContain("claw-farm-local-dev-key");
    expect(compose).not.toContain("api-proxy");
  });

  it("uses the Docker host instance directory when provided", () => {
    const runtime = getRuntime("hermes");
    const compose = runtime.instanceComposeTemplate(
      "clawbay",
      "alice",
      28642,
      "none",
      "/runtime/instance",
    );

    expect(compose).toContain("- /runtime/instance/hermes:/opt/data");
  });

  it("keeps claw-farm metadata separate from Hermes runtime config", () => {
    const runtime = getRuntime("hermes");
    const config = JSON.parse(runtime.configTemplate("demo", "builtin", "gemini"));

    expect(runtime.configFileName).toBe(".claw-farm-hermes.json");
    expect(config.runtime).toBe("hermes");
    expect(JSON.stringify(config)).not.toContain("API_SERVER_KEY");
  });
});
