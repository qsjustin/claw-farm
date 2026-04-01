import { describe, it, expect } from "bun:test";
import { resolveRuntimeConfig, type ClawFarmConfig } from "../config.ts";

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
