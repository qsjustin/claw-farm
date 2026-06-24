import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Bridge dispatch tests for instance.export.
 *
 * Two levels of testing:
 * 1. Producer-level: direct exportInstanceBundle() calls (fast, no subprocess)
 * 2. Bridge dispatch: full bridge command via subprocess (real dispatch chain)
 */

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-bridge-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function seedWorkspace(projectDir: string, userId: string): Promise<void> {
  const layout = join(projectDir, "workspace");
  await mkdir(join(layout, "config"), { recursive: true });
  await mkdir(join(layout, "skills"), { recursive: true });
  await mkdir(join(layout, "sessions"), { recursive: true });
  await mkdir(join(layout, "runtime"), { recursive: true });
  await writeFile(join(layout, "config", "agent.json"), '{"ok":true}\n', "utf8");
  await writeFile(join(layout, "skills", "skill.md"), "# skill\n", "utf8");
}

// ── Producer-level tests (direct exportInstanceBundle) ──

describe("backup bundle producer (exportInstanceBundle)", () => {
  it("accepts valid external backupId and produces output within exportRoot", async () => {
    const projectDir = join(tmp, "demo");
    await seedWorkspace(projectDir, "alice");
    const exportRoot = join(tmp, "exports");

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

    expect(result.bundlePath.startsWith(exportRoot)).toBe(true);
    expect(result.manifestPath.startsWith(exportRoot)).toBe(true);
    expect(result.checksumPath.startsWith(exportRoot)).toBe(true);
    expect(result.bundlePath).toContain("bkp_test123");
    expect(result.manifest.backupId).toBe("bkp_test123");
    expect(result.manifest.fileCount).toBeGreaterThan(0);
    expect(result.manifest.checksum.startsWith("sha256:")).toBe(true);
  });

  it("rejects backupId with path traversal", async () => {
    const projectDir = join(tmp, "demo");
    await seedWorkspace(projectDir, "alice");
    const exportRoot = join(tmp, "exports");

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
        backupId: "../../etc/passwd",
        includedPaths: ["config"],
        excludedPaths: ["cache"],
        bundleFormat: "tar.zst",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Verify no file was written at the malicious path
    const maliciousPath = join(exportRoot, "..", "..", "etc", "passwd");
    const exists = await Bun.file(maliciousPath).exists().catch(() => false);
    expect(exists).toBe(false);
  });

  it("rejects backupId with absolute path", async () => {
    const projectDir = join(tmp, "demo");
    await seedWorkspace(projectDir, "alice");
    const exportRoot = join(tmp, "exports");

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
    const projectDir = join(tmp, "demo");
    await seedWorkspace(projectDir, "alice");
    const exportRoot = join(tmp, "exports");

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

  it("works without external backupId (safe internal fallback)", async () => {
    const projectDir = join(tmp, "demo");
    await seedWorkspace(projectDir, "alice");
    const exportRoot = join(tmp, "exports");

    const { exportInstanceBundle } = await import("../backup-bundle.ts");
    const result = await exportInstanceBundle({
      projectDir,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      includedPaths: ["config", "skills", "sessions"],
      excludedPaths: ["cache", "tmp"],
      bundleFormat: "tar.zst",
    });

    expect(result.bundlePath.startsWith(exportRoot)).toBe(true);
    expect(result.manifest.backupId).toBeTruthy();
    expect(result.manifest.backupId.includes("/")).toBe(false);
    expect(result.manifest.backupId.includes("..")).toBe(false);
  });

  it("rejects overlong backupId", async () => {
    const projectDir = join(tmp, "demo");
    await seedWorkspace(projectDir, "alice");
    const exportRoot = join(tmp, "exports");

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
