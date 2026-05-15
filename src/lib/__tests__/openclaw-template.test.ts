import { describe, expect, it } from "bun:test";
import { openclawConfigTemplate } from "../../templates/openclaw.json.ts";
import { instanceComposeTemplate } from "../../templates/docker-compose.instance.yml.ts";

describe("OpenClaw runtime templates", () => {
  it("generates OpenClaw config compatible with gateway HTTP endpoints", () => {
    const config = JSON.parse(openclawConfigTemplate("alice", "builtin")) as {
      models: { providers: { google: { models: Array<{ id: string; name: string }> } } };
      gateway: {
        auth: { mode: string };
        http: { endpoints: { responses: { enabled: boolean }; chatCompletions: { enabled: boolean } } };
      };
    };

    expect(config.models.providers.google.models).toEqual([{
      id: "google/gemini-2.5-flash",
      name: "google/gemini-2.5-flash",
    }]);
    expect(config.gateway.auth.mode).toBe("token");
    expect(config.gateway.http.endpoints.responses.enabled).toBe(true);
    expect(config.gateway.http.endpoints.chatCompletions.enabled).toBe(true);
  });

  it("requires an OpenClaw gateway token in generated instance compose", () => {
    const compose = instanceComposeTemplate("clawbay-openclaw", "user-1", 18789, "none", "/runtime/instance");

    expect(compose).toContain("OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN:?");
    expect(compose).toContain("/runtime/instance/openclaw:/home/node/.openclaw");
  });

  it("uses direct provider config when OpenClaw is not using an api-proxy service", () => {
    const config = JSON.parse(openclawConfigTemplate("alice", "builtin", "gemini", { useProxy: false })) as {
      env?: Record<string, string>;
      models: { providers: { google: { baseUrl: string } } };
    };

    expect(config.models.providers.google.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(config.env).toBeUndefined();
  });
});
