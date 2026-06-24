import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Bridge dispatch tests for instance.export.
 *
 * Tests the full bridge dispatch chain by:
 * 1. Creating a real project directory with workspace layout
 * 2. Setting CLAW_FARM_REGISTRY_DIR to a temp registry
 * 3. Calling dispatch("instance.export", payload) directly
 *
 * This exercises: payload parse → requireManagedInstance → resolveProjectName
 * → readProjectConfig → resolveRuntimeConfig → resolveWorkspaceLayout
 * → getInstance → bridgeInstanceExport → exportCommand → exportInstanceBundle
 */

let tmp: string;
let registryDir: string;
let projectDir: string;
let origRegistryDir: string | undefined;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-bridge-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  registryDir = join(tmp, "registry");
  projectDir = join(tmp, "demo");

  await mkdir(registryDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // Create workspace layout
  const wsRoot = join(projectDir, "workspace");
  await mkdir(join(wsRoot, "config"), { recursive: true });
  await mkdir(join(wsRoot, "skills"), { recursive: true });
  await mkdir(join(wsRoot, "sessions"), { recursive: true });
  await mkdir(join(wsRoot, "runtime"), { recursive: true });
  await writeFile(join(wsRoot, "config", "agent.json"), '{"ok":true}\n', "utf8");
  await writeFile(join(wsRoot, "skills", "skill.md"), "# skill\n", "utf8");

  // Create project config
  await writeFile(join(projectDir, "claw-farm.yaml"), `
runtime: openclaw
gateway:
  port: 18789
`, "utf8");

  // Create registry with project and instance (matching Registry schema)
  const registry = {
    projects: {
      demo: {
        path: projectDir,
        port: 18789,
        processor: "builtin",
        createdAt: new Date().toISOString(),
        runtime: "openclaw",
        instances: {
          alice: {
            id: "inst-alice",
            userId: "alice",
            status: "running",
            runtimeType: "openclaw",
            createdAt: new Date().toISOString(),
          },
        },
      },
    },
    nextPort: 18790,
  };
  await writeFile(join(registryDir, "registry.json"), JSON.stringify(registry, null, 2));

  // Point registry to our temp dir
  origRegistryDir = process.env.CLAW_FARM_REGISTRY_DIR;
  process.env.CLAW_FARM_REGISTRY_DIR = registryDir;
});

afterEach(async () => {
  if (origRegistryDir === undefined) {
    delete process.env.CLAW_FARM_REGISTRY_DIR;
  } else {
    process.env.CLAW_FARM_REGISTRY_DIR = origRegistryDir;
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("bridge dispatch: instance.export through dispatch()", () => {
  it("accepts valid external backupId and produces output within exportRoot", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_bridge_test",
      includedPaths: ["config", "skills", "sessions"],
      excludedPaths: ["cache", "tmp"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.action).toBe("instance.export");
      // createBridgeSuccess spreads extra into top-level
      const bundlePath = (output as Record<string, unknown>).bundlePath;
      expect(bundlePath).toBeTruthy();
      expect(String(bundlePath)).toContain(exportRoot);
      expect(String(bundlePath)).toContain("bkp_bridge_test");
    }
  });

  it("rejects malicious backupId via bridge dispatch", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "../../etc/passwd",
      includedPaths: ["config"],
      excludedPaths: ["cache"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(false);
    if (!output.ok) {
      // Error from producer propagates through dispatch as unknown
      // (toBridgeFailure doesn't match backupId validation patterns)
      expect(output.error).toContain("backupId");
    }
  });

  it("rejects absolute path backupId via bridge dispatch", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "/etc/shadow",
      includedPaths: ["config"],
      excludedPaths: ["cache"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.error).toContain("backupId");
    }
  });

  it("rejects control character backupId via bridge dispatch", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_test\x00evil",
      includedPaths: ["config"],
      excludedPaths: ["cache"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.error).toContain("backupId");
    }
  });

  it("works without external backupId (safe fallback) through dispatch", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      includedPaths: ["config", "skills", "sessions"],
      excludedPaths: ["cache", "tmp"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.action).toBe("instance.export");
      // bundlePath is at top-level from extra spread
      const bundlePath = (output as Record<string, unknown>).bundlePath;
      expect(bundlePath).toBeTruthy();
      expect(String(bundlePath)).toContain(exportRoot);
      // Internal IDs should be safe (archiveRef is at top-level from extra spread)
      const archiveRef = (output as Record<string, unknown>).archiveRef;
      expect(archiveRef).toBeTruthy();
      expect(String(archiveRef).includes("/")).toBe(false);
      expect(String(archiveRef).includes("..")).toBe(false);
    }
  });

  it("rejects overlong backupId via bridge dispatch", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      exportRoot,
      backupId: "bkp_" + "a".repeat(200),
      includedPaths: ["config"],
      excludedPaths: ["cache"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.error).toContain("backupId");
    }
  });

  it("rejects missing exportRoot via invalid-payload", async () => {
    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "alice",
      runtimeWorkspaceSlug: "alice",
      includedPaths: ["config"],
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.errorCode).toBe("invalid-payload");
    }
  });

  it("rejects missing instance via runtime-missing", async () => {
    const exportRoot = join(tmp, "exports");
    await mkdir(exportRoot, { recursive: true });

    const { dispatch } = await import("../../commands/bridge.ts");
    const output = await dispatch("instance.export", {
      project: "demo",
      userId: "ghost",
      runtimeWorkspaceSlug: "ghost",
      exportRoot,
      bundleFormat: "tar.zst",
    });

    expect(output.ok).toBe(false);
    if (!output.ok) {
      expect(output.errorCode).toBe("runtime-missing");
    }
  });
});
