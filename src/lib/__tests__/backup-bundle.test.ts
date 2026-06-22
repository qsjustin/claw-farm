import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportInstanceBundle, importInstanceBundle } from "../backup-bundle.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "../workspace-layout.ts";
import type { RuntimeType } from "../../runtimes/interface.ts";

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-backup-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function seedWorkspace(projectDir: string, userId: string, runtimeType: RuntimeType = "openclaw"): Promise<void> {
  const layout = resolveWorkspaceLayout(projectDir, userId, runtimeType);
  await ensureWorkspaceLayout(layout);
  await writeFile(join(layout.configDir, "agent.json"), '{"ok":true}\n', "utf8");
  await writeFile(join(layout.skillsDir, "skill.md"), "# skill\n", "utf8");
  await writeFile(join(layout.sessionsDir, "chat.jsonl"), '{"message":"hi"}\n', "utf8");
  await mkdir(join(layout.runtimeDataDir, "sidecar-weixin"), { recursive: true });
  await writeFile(join(layout.runtimeDataDir, "sidecar-weixin", "config.json"), '{"provider":"weixin"}\n', "utf8");
}

describe("backup bundle", () => {
  it("exports a bundle with manifest, checksum, and no absolute paths in the manifest", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    const result = await exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
    });

    expect(result.bundlePath.endsWith("instance.tar.zst")).toBe(true);
    expect(result.manifestPath.endsWith("manifest.json")).toBe(true);
    expect(result.checksumPath.endsWith("sha256.txt")).toBe(true);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.bundleChecksum.startsWith("sha256:")).toBe(true);

    const manifestText = await readFile(result.manifestPath, "utf8");
    expect(manifestText.includes(tmp)).toBe(false);

    const manifest = JSON.parse(manifestText) as { includedPaths: string[]; workspaceSlug: string };
    expect(manifest.workspaceSlug).toBe("alice");
    expect(manifest.includedPaths).toContain("runtime");
  });

  it("restores exported files back into the workspace", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");
    const layout = resolveWorkspaceLayout(tmp, "alice", "openclaw");

    const exported = await exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
    });

    await writeFile(join(layout.configDir, "agent.json"), '{"ok":false}\n', "utf8");
    await rm(join(layout.skillsDir, "skill.md"), { force: true });

    const imported = await importInstanceBundle({
      projectDir: tmp,
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      bundlePath: exported.bundlePath,
      manifestPath: exported.manifestPath,
    });

    expect(imported.bundleChecksum).toBe(exported.bundleChecksum);
    expect(imported.rebuildRequired).toBe(false);
    expect(await readFile(join(layout.configDir, "agent.json"), "utf8")).toBe('{"ok":true}\n');
    expect(await readFile(join(layout.skillsDir, "skill.md"), "utf8")).toBe("# skill\n");
  });

  it("exports and imports Hermes workspace data for same-runtime migration PoC", async () => {
    await seedWorkspace(tmp, "source", "hermes");
    const exportRoot = join(tmp, "exports");

    const exported = await exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "source",
      runtimeType: "hermes",
      runtimeWorkspaceSlug: "source",
      exportRoot,
    });

    const sourceManifest = JSON.parse(await readFile(exported.manifestPath, "utf8")) as {
      runtimeType: string;
      workspaceSlug: string;
    };
    expect(sourceManifest.runtimeType).toBe("hermes");
    expect(sourceManifest.workspaceSlug).toBe("source");

    const targetLayout = resolveWorkspaceLayout(tmp, "target", "hermes");
    await ensureWorkspaceLayout(targetLayout);
    await writeFile(join(targetLayout.configDir, "agent.json"), '{"ok":"target"}\n', "utf8");

    const imported = await importInstanceBundle({
      projectDir: tmp,
      userId: "target",
      runtimeType: "hermes",
      runtimeWorkspaceSlug: "target",
      bundlePath: exported.bundlePath,
      manifestPath: exported.manifestPath,
    });

    expect(imported.bundleChecksum).toBe(exported.bundleChecksum);
    expect(await readFile(join(targetLayout.configDir, "agent.json"), "utf8")).toBe('{"ok":true}\n');
    expect(await readFile(join(targetLayout.skillsDir, "skill.md"), "utf8")).toBe("# skill\n");
  });

  it("accepts valid external backupId from manual-backup", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    const result = await exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_test123",
    });

    // backupId should appear in the export path
    expect(result.bundlePath).toContain("bkp_test123");

    // manifest should contain the same backupId
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as { backupId: string };
    expect(manifest.backupId).toBe("bkp_test123");
  });

  it("rejects backupId with path traversal", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    await expect(exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "../../etc/passwd",
    })).rejects.toThrow("path separators");
  });

  it("rejects backupId with absolute path", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    await expect(exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "/etc/shadow",
    })).rejects.toThrow("path separators");
  });

  it("rejects backupId with dot segments", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    await expect(exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "../foo",
    })).rejects.toThrow("path separators");
  });

  it("rejects backupId with control characters", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    await expect(exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_test\x00evil",
    })).rejects.toThrow("control characters");
  });

  it("rejects backupId that doesn't match canonical pattern", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    await expect(exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "not-bkp-format",
    })).rejects.toThrow("format invalid");
  });

  it("rejects overlong backupId", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    await expect(exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_" + "a".repeat(200),
    })).rejects.toThrow("format invalid");
  });

  it("works without external backupId (uses internal safe ID)", async () => {
    await seedWorkspace(tmp, "alice");
    const exportRoot = join(tmp, "exports");

    // No backupId provided — should use internally generated safe ID
    const result = await exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
    });

    expect(result.bundlePath.endsWith("instance.tar.zst")).toBe(true);

    // manifest should contain a valid backupId
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as { backupId: string };
    expect(manifest.backupId).toMatch(/^bkp_[A-Za-z0-9_-]+$/);
  });

  it("rejects cross-runtime imports", async () => {
    await seedWorkspace(tmp, "alice", "openclaw");
    const exportRoot = join(tmp, "exports");

    const exported = await exportInstanceBundle({
      projectDir: tmp,
      projectName: "demo",
      userId: "alice",
      runtimeType: "openclaw",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
    });

    await seedWorkspace(tmp, "hermes-target", "hermes");

    await expect(importInstanceBundle({
      projectDir: tmp,
      userId: "hermes-target",
      runtimeType: "hermes",
      runtimeWorkspaceSlug: "hermes-target",
      bundlePath: exported.bundlePath,
      manifestPath: exported.manifestPath,
    })).rejects.toThrow('Bundle runtimeType mismatch: expected "hermes", got "openclaw"');
  });
});
