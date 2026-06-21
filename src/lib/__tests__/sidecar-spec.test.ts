/**
 * #171: Sidecar spec persistence behavioral tests.
 *
 * Tests fail-closed semantics, strict field validation, atomic write,
 * and schema version enforcement.
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
  SidecarSpecError,
  type SidecarSpec,
} from "../sidecar-spec.ts";

const validSpec: SidecarSpec = {
  schemaVersion: 1,
  enabled: true,
  serviceName: "weixin-sidecar",
  envFile: ".env.weixin",
  port: 8787,
  composeProject: "clawbay-hermes-user1",
  updatedAt: "2026-06-21T12:00:00.000Z",
};

describe("sidecar-spec persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sidecar-spec-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes and reads back a valid sidecar spec", async () => {
    await writeSidecarSpec(tempDir, { ...validSpec });
    const read = await readSidecarSpec(tempDir);

    expect(read).not.toBeNull();
    expect(read!.schemaVersion).toBe(1);
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

  it("throws SidecarSpecError for corrupted JSON", async () => {
    await Bun.write(join(tempDir, "sidecar-spec.json"), "{ not valid json ");
    expect(readSidecarSpec(tempDir)).rejects.toThrow(SidecarSpecError);
    expect(readSidecarSpec(tempDir)).rejects.toMatchObject({ code: "spec-corrupted" });
  });

  it("throws for missing schemaVersion", async () => {
    const badSpec = { ...validSpec, schemaVersion: undefined } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for wrong schemaVersion", async () => {
    const badSpec = { ...validSpec, schemaVersion: 2 };
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for wrong serviceName", async () => {
    const badSpec = { ...validSpec, serviceName: "evil-sidecar" };
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for path traversal in envFile", async () => {
    const badSpec = { ...validSpec, envFile: "../../etc/passwd" } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for non-.env.weixin envFile", async () => {
    const badSpec = { ...validSpec, envFile: ".env.evil" } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for wrong port", async () => {
    const badSpec = { ...validSpec, port: 9999 } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for Docker-unsafe composeProject", async () => {
    const badSpec = { ...validSpec, composeProject: "proj; rm -rf /" } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for non-ISO updatedAt", async () => {
    const badSpec = { ...validSpec, updatedAt: "not-a-date" } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("throws for unknown field", async () => {
    const badSpec = { ...validSpec, evil: true } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("isSidecarEnabled returns true when spec enabled", async () => {
    await writeSidecarSpec(tempDir, { ...validSpec });
    expect(await isSidecarEnabled(tempDir)).toBe(true);
  });

  it("isSidecarEnabled returns false when spec disabled", async () => {
    await writeSidecarSpec(tempDir, { ...validSpec, enabled: false });
    expect(await isSidecarEnabled(tempDir)).toBe(false);
  });

  it("isSidecarEnabled returns false when no spec exists", async () => {
    expect(await isSidecarEnabled(tempDir)).toBe(false);
  });

  it("isSidecarEnabled throws on corrupted spec", async () => {
    await Bun.write(join(tempDir, "sidecar-spec.json"), "corrupted");
    expect(isSidecarEnabled(tempDir)).rejects.toThrow(SidecarSpecError);
  });

  it("removeSidecarSpec deletes the spec file", async () => {
    await writeSidecarSpec(tempDir, { ...validSpec });
    expect(await isSidecarEnabled(tempDir)).toBe(true);

    await removeSidecarSpec(tempDir);
    expect(await readSidecarSpec(tempDir)).toBeNull();
    expect(await isSidecarEnabled(tempDir)).toBe(false);
  });

  it("removeSidecarSpec is idempotent", async () => {
    await removeSidecarSpec(tempDir);
    await removeSidecarSpec(tempDir);
  });

  it("spec with externalNetwork round-trips correctly", async () => {
    const spec: SidecarSpec = {
      ...validSpec,
      externalNetwork: "clawbay_default",
    };
    await writeSidecarSpec(tempDir, spec);
    const read = await readSidecarSpec(tempDir);
    expect(read).not.toBeNull();
    expect(read!.externalNetwork).toBe("clawbay_default");
  });

  it("throws for Docker-unsafe externalNetwork", async () => {
    const badSpec = { ...validSpec, externalNetwork: "net;evil" } as unknown as SidecarSpec;
    expect(writeSidecarSpec(tempDir, badSpec)).rejects.toThrow(SidecarSpecError);
  });

  it("concurrent writes do not produce corrupted files", async () => {
    // Write 5 specs concurrently — each should succeed without corruption
    const specs = Array.from({ length: 5 }, (_, i) => ({
      ...validSpec,
      composeProject: `proj-${i}`,
      updatedAt: new Date().toISOString(),
    }));

    await Promise.all(specs.map((s) => writeSidecarSpec(tempDir, s)));

    // Final state should be one of the 5, and must be valid
    const read = await readSidecarSpec(tempDir);
    expect(read).not.toBeNull();
    expect(read!.schemaVersion).toBe(1);
    expect(read!.serviceName).toBe("weixin-sidecar");
  });
});
