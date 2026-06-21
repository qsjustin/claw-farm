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

// ─── #171 behavioral: upInstance with real project + mocked compose/fetch ───
//
// These tests create a real temp project in the claw-farm registry,
// write a sidecar spec, then call upInstance() with mocked Bun.spawn
// (for docker compose commands) and mocked fetch (for token rotation).
// They verify the actual code path, not simulated logic.

import { upInstance } from "../api.ts";
import { writeSidecarSpec as _writeSpec2 } from "../sidecar-spec.ts";
import { addProject, addInstance, removeInstance } from "../registry.ts";
import { ensureInstanceDirs } from "../instance.ts";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";

describe("upInstance behavioral — sidecar spec integration", () => {
  let tmpProjectDir: string;
  let tmpHome: string;
  let projectName: string;
  let testCounter = 0;
  const userId = "test-user-171";
  const originalSpawn = Bun.spawn;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    testCounter++;
    projectName = `test-171-${Date.now()}-${testCounter}`;
    tmpProjectDir = await mkdtemp(join(tmpdir(), "claw-farm-171-"));
    // Isolate registry via CLAW_FARM_REGISTRY_DIR env var
    tmpHome = await mkdtemp(join(tmpdir(), "claw-farm-home-"));
    process.env.CLAW_FARM_REGISTRY_DIR = tmpHome;
    // Set required env for sidecar network resolution
    process.env.CLAW_FARM_RUNTIME_ATTACH_NETWORKS = "clawbay_default";
    // Create project in registry — fail on setup errors (no catch/swallow)
    await addProject(projectName, tmpProjectDir, "builtin", "hermes");
    // Set multiInstance flag
    const { loadRegistry, saveRegistry } = await import("../registry.ts");
    const reg = await loadRegistry();
    reg.projects[projectName].multiInstance = true;
    await saveRegistry(reg);

    // Create instance dirs
    await ensureInstanceDirs(tmpProjectDir, userId, "hermes");

    // Add instance to registry — fail on setup errors
    await addInstance(projectName, userId);

    // Write project config
    await fsWriteFile(
      join(tmpProjectDir, "project.json"),
      JSON.stringify({ multiInstance: true, runtime: "hermes" }),
    );
  });

  afterEach(async () => {
    // Restore and cleanup
    Bun.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
    delete process.env.CLAW_FARM_RUNTIME_ATTACH_NETWORKS;
    delete process.env.CLAW_FARM_REGISTRY_DIR;
    // Registry is in tmpHome which gets rm'd, no need to removeInstance
    await rm(tmpProjectDir, { recursive: true, force: true });
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("enabled spec + no explicit options → compose includes sidecar, rotation called", async () => {
    // Write sidecar spec
    const instDir = join(tmpProjectDir, "instances", userId);
    await _writeSpec2(instDir, {
      schemaVersion: 1,
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: `${projectName}-${userId}`,
      updatedAt: new Date().toISOString(),
    });

    // Track compose commands and fetch calls
    const composeCommands: string[] = [];
    const fetchCalls: { url: string; method: string }[] = [];

    // Mock Bun.spawn for docker compose commands
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      composeCommands.push(args.join(" "));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;

    // Mock fetch for token rotation
    globalThis.fetch = ((url: string, opts?: RequestInit) => {
      fetchCalls.push({ url: url as string, method: opts?.method ?? "GET" });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, token: "cbt_test123" }), { status: 200 }),
      );
    }) as typeof fetch;

    // Call upInstance with rotation inputs but no explicit enableWeixinSidecar
    // Should read spec and enable sidecar
    await upInstance(projectName, userId, {
      quiet: true,
      managedInstanceId: "sri_test_171",
      clawBayApiUrl: "http://claw-bay-api:3001",
      clawBayAdminToken: "test-admin-token",
    });

    // Verify compose was called (at least start or up)
    expect(composeCommands.length).toBeGreaterThan(0);
    expect(composeCommands.some((c) => c.includes("docker compose"))).toBe(true);

    // Verify token rotation was called (because spec enabled it)
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toContain("/api/internal/weixin-binding-provision/rotate");
    expect(fetchCalls[0].method).toBe("POST");

    // Verify compose file was written with sidecar service
    const composeContent = await Bun.file(join(instDir, "docker-compose.openclaw.yml")).text();
    expect(composeContent).toContain("weixin-sidecar");
  });

  it("corrupted spec → throws, compose not written, commands not run", async () => {
    const instDir = join(tmpProjectDir, "instances", userId);
    // Write corrupted spec
    await Bun.write(join(instDir, "sidecar-spec.json"), "{ corrupted json");

    const composeCommands: string[] = [];
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      composeCommands.push(args.join(" "));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;

    // Should throw SidecarSpecError
    await expect(
      upInstance(projectName, userId, {
        quiet: true,
        managedInstanceId: "sri_test",
        clawBayApiUrl: "http://api:3001",
        clawBayAdminToken: "token",
      }),
    ).rejects.toThrow();

    // No compose commands should have been run
    expect(composeCommands).toHaveLength(0);
  });

  it("enabled spec + missing rotation inputs → throws, no compose commands", async () => {
    const instDir = join(tmpProjectDir, "instances", userId);
    await _writeSpec2(instDir, {
      schemaVersion: 1,
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: `${projectName}-${userId}`,
      updatedAt: new Date().toISOString(),
    });

    const composeCommands: string[] = [];
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      composeCommands.push(args.join(" "));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;

    // Missing managedInstanceId, clawBayApiUrl, clawBayAdminToken
    await expect(
      upInstance(projectName, userId, { quiet: true }),
    ).rejects.toThrow("missing token rotation inputs");

    expect(composeCommands).toHaveLength(0);
  });

  it("explicit false → sidecar disabled, spec removed, no rotation fetch", async () => {
    const instDir = join(tmpProjectDir, "instances", userId);
    await _writeSpec2(instDir, {
      schemaVersion: 1,
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: `${projectName}-${userId}`,
      updatedAt: new Date().toISOString(),
    });

    const fetchCalls: { url: string }[] = [];
    const composeCommands: string[] = [];

    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      composeCommands.push(args.join(" "));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;

    globalThis.fetch = ((url: string) => {
      fetchCalls.push({ url: url as string });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch;

    // Explicit false should disable sidecar and remove spec
    await upInstance(projectName, userId, {
      quiet: true,
      enableWeixinSidecar: false,
    });

    // No rotation fetch should have been called
    expect(fetchCalls).toHaveLength(0);

    // Spec should be removed
    const specExists = await Bun.file(join(instDir, "sidecar-spec.json")).exists();
    expect(specExists).toBe(false);

    // Compose should NOT contain sidecar
    const composeContent = await Bun.file(join(instDir, "docker-compose.openclaw.yml")).text();
    expect(composeContent).not.toContain("weixin-sidecar");
  });

  it("rotate fetch failure → throws, no compose start/up command", async () => {
    const instDir = join(tmpProjectDir, "instances", userId);
    await _writeSpec2(instDir, {
      schemaVersion: 1,
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: `${projectName}-${userId}`,
      updatedAt: new Date().toISOString(),
    });

    const composeCommands: string[] = [];

    Bun.spawn = ((_args: string[], _opts?: { cwd?: string }) => {
      composeCommands.push(_args.join(" "));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;

    // Mock fetch to return rotate failure
    globalThis.fetch = ((_url: string) => {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "token rotation denied" }), { status: 403 }),
      );
    }) as typeof fetch;

    await expect(
      upInstance(projectName, userId, {
        quiet: true,
        managedInstanceId: "sri_test",
        clawBayApiUrl: "http://api:3001",
        clawBayAdminToken: "token",
      }),
    ).rejects.toThrow("token rotation failed");

    // No compose start/up should have run
    expect(composeCommands.filter(c => c.includes("start") || c.includes("up"))).toHaveLength(0);
  });
});

// ─── #171 behavioral: rotate failure prevents compose start ──────────────────
