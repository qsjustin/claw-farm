import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shouldPreserveInstanceData, writeInstanceModelEnv } from "../api.ts";

describe("instance data retention policy", () => {
  it("retains Hermes /opt/data by default", () => {
    expect(shouldPreserveInstanceData("hermes")).toBe(true);
  });

  it("requires explicit deleteData to remove Hermes data", () => {
    expect(shouldPreserveInstanceData("hermes", { deleteData: true })).toBe(false);
  });

  it("keeps OpenClaw default behavior unless keepData is requested", () => {
    expect(shouldPreserveInstanceData("openclaw")).toBe(false);
    expect(shouldPreserveInstanceData("openclaw", { keepData: true })).toBe(true);
  });
});

describe("instance model env policy", () => {
  it("writes .env.model with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claw-farm-model-env-"));

    try {
      await writeInstanceModelEnv(dir, {
        provider: "anthropic",
        apiKey: "sk-ant-test",
        modelSlug: "anthropic/claude-sonnet-4-6",
      });

      const fileStat = await stat(join(dir, ".env.model"));
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
