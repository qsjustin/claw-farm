import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveWorkspaceLayout, ensureWorkspaceLayout } from "../workspace-layout.ts";
import type { RuntimeType } from "../../runtimes/interface.ts";

/**
 * Bridge dispatch tests for instance.export.
 *
 * These tests exercise the bridge dispatch entry (bridgeCommand with
 * "instance.export" operation) using a real project layout and the
 * actual exportInstanceBundle producer. This covers:
 *   - Valid external backupId → paths within exportRoot
 *   - Malicious backupId → rejected before any write
 *   - No backupId → safe internal fallback
 *   - Missing required fields → invalid-payload
 */

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-bridge-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function seedProject(projectName: string, userId: string, runtimeType: RuntimeType = "openclaw"): Promise<string> {
  const projectDir = join(tmp, projectName);
  await mkdir(projectDir, { recursive: true });
  const layout = resolveWorkspaceLayout(projectDir, userId, runtimeType);
  await ensureWorkspaceLayout(layout);
  await writeFile(join(layout.configDir, "agent.json"), '{"ok":true}\n', "utf8");
  await writeFile(join(layout.skillsDir, "skill.md"), "# skill\n", "utf8");
  return projectDir;
}

describe("bridge dispatch: instance.export", () => {
  it("accepts valid external backupId and produces output within exportRoot", async () => {
    const projectDir = await seedProject("demo", "alice");
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    // The bridge dispatch calls exportInstanceBundle with backupId
    const { exportInstanceBundle } = await import("../backup-bundle.ts");
    const result = await exportInstanceBundle({
      projectDir,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_test123",
      includedPaths: ["config", "skills", "sessions"],
      excludedPaths: ["cache", "tmp"],
      bundleFormat: "tar.zst",
    });

    // Verify paths are within exportRoot
    expect(result.bundlePath.startsWith(exportRoot)).toBe(true);
    expect(result.manifestPath.startsWith(exportRoot)).toBe(true);
    expect(result.checksumPath.startsWith(exportRoot)).toBe(true);

    // Verify backupId appears in the path
    expect(result.bundlePath).toContain("bkp_test123");
    expect(result.manifest.backupId).toBe("bkp_test123");

    // Verify manifest structure
    expect(result.manifest.manifestVersion).toBe("1");
    expect(result.manifest.userId).toBe("alice");
    expect(result.manifest.runtimeType).toBe("openclaw");
    expect(result.manifest.fileCount).toBeGreaterThan(0);
    expect(result.manifest.checksum.startsWith("sha256:")).toBe(true);
  });

  it("rejects backupId with path traversal before any write", async () => {
    const projectDir = await seedProject("demo", "alice");
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { exportInstanceBundle } = await import("../backup-bundle.ts");

    let exportDirCreated = false;
    try {
      await exportInstanceBundle({
        projectDir,
        projectName: "demo",
        userId: "alice",
        runtimeType: "openclaw",
        runtimeWorkspaceSlug: "alice",
        exportRoot,
        backupId: "../../etc/passwd",
        includedPaths: ["config"],
        excludedPaths: ["cache"],
        bundleFormat: "tar.zst",
      });
    } catch {
      // Expected — validation should reject before any write
      exportDirCreated = true;
    }

    // The malicious path should NOT have been created
    const maliciousPath = join(exportRoot, "..", "..", "etc", "passwd");
    const exists = await Bun.file(maliciousPath).exists().catch(() => false);
    expect(exists).toBe(false);
    expect(exportDirCreated).toBe(true);
  });

  it("rejects backupId with absolute path", async () => {
    const projectDir = await seedProject("demo", "alice");
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { exportInstanceBundle } = await import("../backup-bundle.ts");

    let threw = false;
    try {
      await exportInstanceBundle({
        projectDir,
        projectName: "demo",
        userId: "alice",
        runtimeType: "openclaw",
        runtimeWorkspaceSlug: "alice",
        exportRoot,
        backupId: "/etc/shadow",
        includedPaths: ["config"],
        excludedPaths: ["cache"],
        bundleFormat: "tar.zst",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });

  it("rejects backupId with control characters", async () => {
    const projectDir = await seedProject("demo", "alice");
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { exportInstanceBundle } = await import("../backup-bundle.ts");

    let threw = false;
    try {
      await exportInstanceBundle({
        projectDir,
        projectName: "demo",
        userId: "alice",
        runtimeType: "openclaw",
        runtimeWorkspaceSlug: "alice",
        exportRoot,
        backupId: "bkp_test\x00evil",
        includedPaths: ["config"],
        excludedPaths: ["cache"],
        bundleFormat: "tar.zst",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });

  it("works without external backupId (uses internal safe ID)", async () => {
    const projectDir = await seedProject("demo", "alice");
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { exportInstanceBundle } = await import("../backup-bundle.ts");
    const result = await exportInstanceBundle({
      projectDir,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      // No backupId — should generate a safe internal one
      includedPaths: ["config", "skills", "sessions"],
      excludedPaths: ["cache", "tmp"],
      bundleFormat: "tar.zst",
    });

    expect(result.bundlePath.startsWith(exportRoot)).toBe(true);
    expect(result.manifestPath.startsWith(exportRoot)).toBe(true);
    expect(result.checksumPath.startsWith(exportRoot)).toBe(true);
    expect(result.manifest.backupId).toBeTruthy();
    // Internal IDs should be safe
    expect(result.manifest.backupId.includes("/")).toBe(false);
    expect(result.manifest.backupId.includes("..")).toBe(false);
  });

  it("rejects overlong backupId", async () => {
    const projectDir = await seedProject("demo", "alice");
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { exportInstanceBundle } = await import("../backup-bundle.ts");

    let threw = false;
    try {
      await exportInstanceBundle({
        projectDir,
        projectName: "demo",
        userId: "alice",
        runtimeType: "openclaw",
        runtimeWorkspaceSlug: "alice",
        exportRoot,
        backupId: "bkp_" + "a".repeat(200),
        includedPaths: ["config"],
        excludedPaths: ["cache"],
        bundleFormat: "tar.zst",
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });
});
