import { describe, it, expect } from "bun:test";
import { renderInstanceModelEnv, resolveRuntimeConfig, type ClawFarmConfig } from "../config.ts";

const baseEntry = { runtime: undefined } as { runtime: undefined };

describe("resolveRuntimeConfig", () => {
  it("defaults to openclaw when config is null and entry has no runtime", () => {
    const result = resolveRuntimeConfig(null, baseEntry);
    expect(result.runtimeType).toBe("openclaw");
    expect(result.proxyMode).toBe("per-instance"); // openclaw defaultProxyMode
  });

  it("defaults to openclaw when entry.runtime is undefined", () => {
    const result = resolveRuntimeConfig(null, { runtime: undefined });
    expect(result.runtimeType).toBe("openclaw");
  });

  it("uses picoclaw from config.runtime", () => {
    const config: ClawFarmConfig = {
      name: "test",
      processor: "builtin",
      port: 18789,
      createdAt: "2026-01-01T00:00:00.000Z",
      runtime: "picoclaw",
    };
    const result = resolveRuntimeConfig(config, baseEntry);
    expect(result.runtimeType).toBe("picoclaw");
    expect(result.proxyMode).toBe("shared"); // picoclaw defaultProxyMode
  });

  it("uses openclaw from config.runtime", () => {
    const config: ClawFarmConfig = {
      name: "test",
      processor: "builtin",
      port: 18789,
      createdAt: "2026-01-01T00:00:00.000Z",
      runtime: "openclaw",
    };
    const result = resolveRuntimeConfig(config, baseEntry);
    expect(result.runtimeType).toBe("openclaw");
    expect(result.proxyMode).toBe("per-instance");
  });

  it("uses hermes from config.runtime", () => {
    const config: ClawFarmConfig = {
      name: "test",
      processor: "builtin",
      port: 18789,
      createdAt: "2026-01-01T00:00:00.000Z",
      runtime: "hermes",
    };
    const result = resolveRuntimeConfig(config, baseEntry);
    expect(result.runtimeType).toBe("hermes");
    expect(result.runtime.runtimeDirName).toBe("hermes");
    expect(result.proxyMode).toBe("none");
  });

  it("uses entry.runtime when config is null", () => {
    const result = resolveRuntimeConfig(null, { runtime: "picoclaw" });
    expect(result.runtimeType).toBe("picoclaw");
  });

  it("respects proxyMode: none from config", () => {
    const config: ClawFarmConfig = {
      name: "test",
      processor: "builtin",
      port: 18789,
      createdAt: "2026-01-01T00:00:00.000Z",
      runtime: "openclaw",
      proxyMode: "none",
    };
    const result = resolveRuntimeConfig(config, baseEntry);
    expect(result.proxyMode).toBe("none");
  });

  it("respects proxyMode: per-instance from config", () => {
    const config: ClawFarmConfig = {
      name: "test",
      processor: "builtin",
      port: 18789,
      createdAt: "2026-01-01T00:00:00.000Z",
      proxyMode: "per-instance",
    };
    const result = resolveRuntimeConfig(config, baseEntry);
    expect(result.proxyMode).toBe("per-instance");
  });

  it("respects proxyMode: shared from config", () => {
    const config: ClawFarmConfig = {
      name: "test",
      processor: "builtin",
      port: 18789,
      createdAt: "2026-01-01T00:00:00.000Z",
      proxyMode: "shared",
    };
    const result = resolveRuntimeConfig(config, baseEntry);
    expect(result.proxyMode).toBe("shared");
  });

  it("returns a valid runtime object", () => {
    const result = resolveRuntimeConfig(null, baseEntry);
    expect(result.runtime).toBeDefined();
    expect(typeof result.runtime.defaultProxyMode).toBe("string");
  });
});

describe("renderInstanceModelEnv", () => {
  it("emits Hermes provider and model env for Anthropic", () => {
    const env = renderInstanceModelEnv({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      modelSlug: "anthropic/claude-sonnet-4-6",
    });

    expect(env).toContain("LLM_PROVIDER=anthropic");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=anthropic");
    expect(env).toContain("HERMES_INFERENCE_MODEL=anthropic/claude-sonnet-4-6");
    expect(env).toContain("ANTHROPIC_API_KEY=sk-ant-test");
  });

  it("maps openai-compat to Hermes custom provider with base URL", () => {
    const env = renderInstanceModelEnv({
      provider: "openai-compat",
      apiKey: "sk-openai-test",
      baseUrl: "https://models.example/v1",
      modelSlug: "openai/custom",
    });

    expect(env).toContain("LLM_PROVIDER=openai-compat");
    expect(env).toContain("HERMES_INFERENCE_PROVIDER=custom");
    expect(env).toContain("HERMES_INFERENCE_MODEL=openai/custom");
    expect(env).toContain("OPENAI_API_KEY=sk-openai-test");
    expect(env).toContain("OPENAI_COMPAT_BASE_URL=https://models.example/v1");
    expect(env).toContain("CUSTOM_BASE_URL=https://models.example/v1");
  });

  it("rejects newline injection in model env values", () => {
    expect(() => renderInstanceModelEnv({
      provider: "anthropic",
      apiKey: "sk-test\nINJECTED=1",
      modelSlug: "anthropic/claude-sonnet-4-6",
    })).toThrow("newline");

    expect(() => renderInstanceModelEnv({
      provider: "anthropic",
      apiKey: "sk-test",
      modelSlug: "anthropic/claude-sonnet-4-6\rINJECTED=1",
    })).toThrow("newline");
  });

  it("rejects unsafe openai-compatible base URLs", () => {
    expect(() => renderInstanceModelEnv({
      provider: "openai-compat",
      apiKey: "sk-test",
      baseUrl: "https://user:pass@models.example/v1",
    })).toThrow("must not contain credentials");

    expect(() => renderInstanceModelEnv({
      provider: "openai-compat",
      apiKey: "sk-test",
      baseUrl: "file:///tmp/model",
    })).toThrow("http or https");
  });
});
