/**
 * #171: Sidecar spec persistence behavioral tests.
 *
 * Verifies that:
 * 1. writeSidecarSpec / readSidecarSpec round-trip works
 * 2. readSidecarSpec returns null when no spec exists
 * 3. isSidecarEnabled returns correct boolean
 * 4. removeSidecarSpec cleans up
 * 5. Spec survives across simulated lifecycle operations
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSidecarSpec,
  readSidecarSpec,
  removeSidecarSpec,
  isSidecarEnabled,
  type SidecarSpec,
} from "../sidecar-spec.ts";

describe("sidecar-spec persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sidecar-spec-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes and reads back a sidecar spec", async () => {
    const spec: SidecarSpec = {
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: "clawbay-hermes-user1",
      updatedAt: "2026-06-21T12:00:00Z",
    };

    await writeSidecarSpec(tempDir, spec);
    const read = await readSidecarSpec(tempDir);

    expect(read).not.toBeNull();
    expect(read!.enabled).toBe(true);
    expect(read!.serviceName).toBe("weixin-sidecar");
    expect(read!.envFile).toBe(".env.weixin");
    expect(read!.port).toBe(8787);
    expect(read!.composeProject).toBe("clawbay-hermes-user1");
  });

  it("returns null when no spec file exists", async () => {
    const read = await readSidecarSpec(tempDir);
    expect(read).toBeNull();
  });

  it("returns null for corrupted spec file", async () => {
    const specPath = join(tempDir, "sidecar-spec.json");
    await Bun.write(specPath, "{ not valid json ");
    const read = await readSidecarSpec(tempDir);
    expect(read).toBeNull();
  });

  it("returns null for spec with missing enabled field", async () => {
    const specPath = join(tempDir, "sidecar-spec.json");
    await Bun.write(specPath, JSON.stringify({ port: 8787 }));
    const read = await readSidecarSpec(tempDir);
    expect(read).toBeNull();
  });

  it("isSidecarEnabled returns true when spec exists and enabled", async () => {
    await writeSidecarSpec(tempDir, {
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: "proj",
      updatedAt: new Date().toISOString(),
    });
    expect(await isSidecarEnabled(tempDir)).toBe(true);
  });

  it("isSidecarEnabled returns false when spec exists but disabled", async () => {
    await writeSidecarSpec(tempDir, {
      enabled: false,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: "proj",
      updatedAt: new Date().toISOString(),
    });
    expect(await isSidecarEnabled(tempDir)).toBe(false);
  });

  it("isSidecarEnabled returns false when no spec exists", async () => {
    expect(await isSidecarEnabled(tempDir)).toBe(false);
  });

  it("removeSidecarSpec deletes the spec file", async () => {
    await writeSidecarSpec(tempDir, {
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: "proj",
      updatedAt: new Date().toISOString(),
    });
    expect(await isSidecarEnabled(tempDir)).toBe(true);

    await removeSidecarSpec(tempDir);
    expect(await readSidecarSpec(tempDir)).toBeNull();
    expect(await isSidecarEnabled(tempDir)).toBe(false);
  });

  it("removeSidecarSpec is idempotent (no error when file doesn't exist)", async () => {
    await removeSidecarSpec(tempDir); // Should not throw
    await removeSidecarSpec(tempDir); // Still should not throw
  });

  it("spec with externalNetwork round-trips correctly", async () => {
    const spec: SidecarSpec = {
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      externalNetwork: "clawbay_default",
      composeProject: "proj",
      updatedAt: "2026-06-21T12:00:00Z",
    };

    await writeSidecarSpec(tempDir, spec);
    const read = await readSidecarSpec(tempDir);
    expect(read).not.toBeNull();
    expect(read!.externalNetwork).toBe("clawbay_default");
  });
});
