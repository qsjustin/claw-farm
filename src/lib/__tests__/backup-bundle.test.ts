import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportInstanceBundle, importInstanceBundle } from "../backup-bundle.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "../workspace-layout.ts";

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-backup-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function seedWorkspace(projectDir: string, userId: string): Promise<void> {
  const layout = resolveWorkspaceLayout(projectDir, userId, "openclaw");
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
});
