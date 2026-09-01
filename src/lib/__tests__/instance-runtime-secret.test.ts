import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureOpenClawGatewayToken, writeInstanceRuntimeEnv } from "../instance-runtime-secret.ts";

describe("per-instance OpenClaw gateway token", () => {
  it("generates a stable owner-only token without exposing it in caller-visible state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-instance-secret-"));
    try {
      const first = await ensureOpenClawGatewayToken(dir);
      const second = await ensureOpenClawGatewayToken(dir);
      const content = await readFile(join(dir, "openclaw-gateway.env"), "utf8");
      const mode = (await stat(join(dir, "openclaw-gateway.env"))).mode & 0o777;

      expect(first).toHaveLength(43);
      expect(second).toBe(first);
      expect(content).toBe(`OPENCLAW_GATEWAY_TOKEN=${first}\n`);
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates a legacy instance token into the gateway-only file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-instance-secret-"));
    const token = "existing-test-gateway-token-123456";
    try {
      await writeFile(join(dir, "instance.env"), `MODEL=example\nOPENCLAW_GATEWAY_TOKEN=${token}\n`, { mode: 0o644 });
      expect(await ensureOpenClawGatewayToken(dir)).toBe(token);
      expect(await readFile(join(dir, "instance.env"), "utf8")).toBe("MODEL=example\n");
      expect(await readFile(join(dir, "openclaw-gateway.env"), "utf8")).toBe(`OPENCLAW_GATEWAY_TOKEN=${token}\n`);
      expect((await stat(join(dir, "openclaw-gateway.env"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed for an empty or duplicated token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-instance-secret-"));
    try {
      await writeFile(join(dir, "openclaw-gateway.env"), "OPENCLAW_GATEWAY_TOKEN=\n");
      await expect(ensureOpenClawGatewayToken(dir)).rejects.toThrow("invalid");

      await writeFile(join(dir, "openclaw-gateway.env"), "OPENCLAW_GATEWAY_TOKEN=one-valid-token-1234\nOPENCLAW_GATEWAY_TOKEN=two-valid-token-5678\n");
      await expect(ensureOpenClawGatewayToken(dir)).rejects.toThrow("duplicated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes ordinary instance env data owner-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-instance-secret-"));
    try {
      await writeInstanceRuntimeEnv(dir, "MODEL=example\n");
      expect(await readFile(join(dir, "instance.env"), "utf8")).toBe("MODEL=example\n");
      expect((await stat(join(dir, "instance.env"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a caller-provided gateway token in the generic instance env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-instance-secret-"));
    try {
      await expect(writeInstanceRuntimeEnv(dir, "OPENCLAW_GATEWAY_TOKEN=caller-controlled-token-1234\n"))
        .rejects.toThrow("Farm-managed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
