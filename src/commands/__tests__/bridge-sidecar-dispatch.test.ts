/**
 * #171 Phase 2A-2: Sidecar attach/detach bridge dispatch tests.
 *
 * Tests the real dispatch() → bridgeSidecarAttach/bDetach → spec write path.
 * Verifies idempotency, stale replay, v1 migration, validation, and full identity.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../bridge.ts";
import { writeSidecarSpec, type SidecarSpec } from "../../lib/sidecar-spec.ts";

const HOME_DIR = join(tmpdir(), "sidecar-dispatch-test");
let home: string;
let projectDir: string;
let instDir: string;
let registryDir: string;
let origRegistryDir: string | undefined;
const projectName = "clawbay-test";
const userId = "test-user";

const validSpec: SidecarSpec = {
  schemaVersion: 2,
  enabled: true,
  serviceName: "weixin-sidecar",
  envFile: ".env.weixin",
  port: 8787,
  composeProject: `${projectName}-${userId}`,
  managedInstanceId: "sri-1",
  bindingId: "binding-1",
  operationId: "op-1",
  targetAttachmentVersion: 1,
  targetConfigVersion: 1,
  desiredAttachmentState: "attached",
  updatedAt: "2026-06-29T00:00:00.000Z",
};

beforeEach(async () => {
  // Clean and recreate
  await rm(HOME_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(HOME_DIR, { recursive: true });
  home = HOME_DIR;
  projectDir = join(home, "projects", projectName);
  instDir = join(projectDir, "instances", userId);
  registryDir = join(home, ".claw-farm");

  // Set registry dir for dispatch calls
  origRegistryDir = process.env.CLAW_FARM_REGISTRY_DIR;
  process.env.CLAW_FARM_REGISTRY_DIR = registryDir;

  // Create project and instance dirs
  await mkdir(join(instDir, "hermes", "workspace"), { recursive: true });
  await mkdir(join(instDir, "hermes", "workspace", "runtime"), { recursive: true });

  // Write registry
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, "registry.json"),
    JSON.stringify({
      projects: {
        [projectName]: {
          path: projectDir,
          port: 18790,
          processor: "builtin",
          createdAt: "2026-06-04T00:00:00.000Z",
          multiInstance: true,
          runtime: "hermes",
          instances: {
            [userId]: {
              userId,
              port: 18791,
              createdAt: "2026-06-04T00:00:00.000Z",
            },
          },
        },
      },
      nextPort: 18792,
    }),
  );

  // Write config
  await writeFile(
    join(projectDir, "claw-farm.config.json"),
    JSON.stringify({
      runtime: "hermes",
      processor: "builtin",
    }),
  );
});

afterEach(() => {
  if (origRegistryDir === undefined) {
    delete process.env.CLAW_FARM_REGISTRY_DIR;
  } else {
    process.env.CLAW_FARM_REGISTRY_DIR = origRegistryDir;
  }
});

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    project: projectName,
    userId,
    managedInstanceId: "sri-1",
    sidecarCode: "weixin-auth-sidecar",
    bindingId: "binding-1",
    operationId: "op-1",
    expectedAttachmentVersion: 0,
    expectedConfigVersion: 1,
    clawBayApiUrl: "http://localhost:3001",
    clawBayAdminToken: "test-admin-token",
    ...overrides,
  };
}

describe("sidecar.attach dispatch", () => {
  let origSpawn: typeof Bun.spawn;
  let origFetch: typeof fetch;

  beforeEach(() => {
    origSpawn = Bun.spawn;
    origFetch = globalThis.fetch;
    // Mock compose + docker inspect commands
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      const cmd = args.join(" ");
      if (cmd.includes("docker inspect")) {
        return {
          exited: Promise.resolve(0),
          stdout: new Blob([args.some(a => a.includes("Health")) ? "healthy" : "true"]).stream(),
          stderr: new Blob([""]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    // Mock globalThis.fetch for provision/revoke API
    globalThis.fetch = ((url: string | URL | Request, _init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("weixin-binding-provision")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, tokenLast4: "1234" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as Promise<Response>;
      }
      return Promise.resolve(new Response("OK", { status: 200 })) as Promise<Response>;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    Bun.spawn = origSpawn;
    globalThis.fetch = origFetch;
  });

  it("attaches when no spec exists (first attach)", async () => {
    const result = await dispatch("sidecar.attach", basePayload());
    if (!result.ok) { console.log("FAIL first-attach:", JSON.stringify(result)); }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("sidecar.attach");
      expect(result.metadata?.appliedTargetVersion).toBe(1);
    }

    // Spec should be written with full identity
    const specContent = await readFile(join(instDir, "sidecar-spec.json"), "utf8");
    const spec = JSON.parse(specContent) as SidecarSpec;
    expect(spec.schemaVersion).toBe(2);
    expect(spec.enabled).toBe(true);
    expect(spec.operationId).toBe("op-1");
    expect(spec.bindingId).toBe("binding-1");
    expect(spec.targetAttachmentVersion).toBe(1);
  });

  it("returns idempotent success when same operation already applied", async () => {
    // Write a spec that matches the expected operation
    await writeSidecarSpec(instDir, {
      ...validSpec,
      operationId: "op-1",
      targetAttachmentVersion: 1,
    });

    const result = await dispatch("sidecar.attach", basePayload());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata?.idempotent).toBe(true);
    }
  });

  it("rejects stale replay (spec version > expected)", async () => {
    // Spec already at v3, but request says expected=0 (target=1)
    await writeSidecarSpec(instDir, {
      ...validSpec,
      targetAttachmentVersion: 3,
    });

    const result = await dispatch("sidecar.attach", basePayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/runtime-conflict|stale/);
    }
  });

  it("rejects same-version overwrite by different operation", async () => {
    // Spec has op-2 applied with targetAttachmentVersion=1
    // New request with op-3 has expected=0 (target=1) — same version, different op
    await writeSidecarSpec(instDir, {
      ...validSpec,
      operationId: "op-2",
      targetAttachmentVersion: 1,
    });

    const result = await dispatch("sidecar.attach", basePayload({
      operationId: "op-3",
      bindingId: "binding-other",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/runtime-conflict/);
    }
  });

  it("rejects when CAS identity mismatches (different bindingId)", async () => {
    await writeSidecarSpec(instDir, {
      ...validSpec,
      operationId: "op-1",
      bindingId: "binding-1",
      targetAttachmentVersion: 1,
    });

    // Same operationId but different bindingId — not idempotent
    const result = await dispatch("sidecar.attach", basePayload({
      bindingId: "binding-other",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/runtime-conflict/);
    }
  });

  it("rejects invalid expectedAttachmentVersion (non-integer)", async () => {
    const result = await dispatch("sidecar.attach", basePayload({
      expectedAttachmentVersion: 1.5,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/invalid-payload/);
    }
  });

  it("rejects invalid expectedAttachmentVersion (negative)", async () => {
    const result = await dispatch("sidecar.attach", basePayload({
      expectedAttachmentVersion: -1,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/invalid-payload/);
    }
  });

  it("rejects missing managedInstanceId", async () => {
    const result = await dispatch("sidecar.attach", {
      ...basePayload(),
      managedInstanceId: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/invalid-payload/);
    }
  });

  it("rolls back spec when health check fails", async () => {
    // Override docker inspect to report container not running
    Bun.spawn = ((args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("docker inspect")) {
        return {
          exited: Promise.resolve(1),
          stdout: new Blob([""]).stream(),
          stderr: new Blob(["No such container"]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const result = await dispatch("sidecar.attach", basePayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/runtime-command-failed/);
      expect(result.message).toContain("health check");
    }

    // Spec should be removed (rolled back)
    const { stat } = await import("node:fs/promises");
    let specExists = false;
    try {
      await stat(join(instDir, "sidecar-spec.json"));
      specExists = true;
    } catch { /* file doesn't exist */ }
    expect(specExists).toBe(false);
  });
});

describe("sidecar.detach dispatch", () => {
  let origSpawn: typeof Bun.spawn;
  let origFetch: typeof fetch;

  beforeEach(() => {
    origSpawn = Bun.spawn;
    origFetch = globalThis.fetch;
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      if (args.join(" ").includes("docker inspect")) {
        return {
          exited: Promise.resolve(1),
          stdout: new Blob([""]).stream(),
          stderr: new Blob(["No such container"]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    globalThis.fetch = ((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("weixin-binding-provision")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, tokenLast4: "1234" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as Promise<Response>;
      }
      return Promise.resolve(new Response("OK", { status: 200 })) as Promise<Response>;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    Bun.spawn = origSpawn;
    globalThis.fetch = origFetch;
  });

  it("detaches an enabled spec", async () => {
    await writeSidecarSpec(instDir, {
      ...validSpec,
      operationId: "op-1",
      targetAttachmentVersion: 1,
      desiredAttachmentState: "attached",
    });

    const result = await dispatch("sidecar.detach", basePayload({
      operationId: "op-2",
      expectedAttachmentVersion: 1,
      expectedConfigVersion: 1,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("sidecar.detach");
      expect(result.metadata?.appliedTargetVersion).toBe(2);
    }

    // Spec should be updated with disabled state
    const specContent = await readFile(join(instDir, "sidecar-spec.json"), "utf8");
    const spec = JSON.parse(specContent) as SidecarSpec;
    expect(spec.enabled).toBe(false);
    expect(spec.desiredAttachmentState).toBe("detached");
    expect(spec.operationId).toBe("op-2");
    expect(spec.targetAttachmentVersion).toBe(2);
  });

  it("returns idempotent success when same operation already applied", async () => {
    await writeSidecarSpec(instDir, {
      ...validSpec,
      enabled: false,
      desiredAttachmentState: "detached",
      operationId: "op-2",
      targetAttachmentVersion: 2,
    });

    const result = await dispatch("sidecar.detach", basePayload({
      operationId: "op-2",
      expectedAttachmentVersion: 1,
      expectedConfigVersion: 1,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata?.idempotent).toBe(true);
    }
  });

  it("rejects when no spec exists", async () => {
    const result = await dispatch("sidecar.detach", basePayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toMatch(/runtime-missing/);
    }
  });
});

describe("sidecar.attach v1 migration", () => {
  let origSpawn: typeof Bun.spawn;
  let origFetch: typeof fetch;

  beforeEach(() => {
    origSpawn = Bun.spawn;
    origFetch = globalThis.fetch;
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      const cmd = args.join(" ");
      if (cmd.includes("docker inspect")) {
        return {
          exited: Promise.resolve(0),
          stdout: new Blob([args.some(a => a.includes("Health")) ? "healthy" : "true"]).stream(),
          stderr: new Blob([""]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    globalThis.fetch = ((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("weixin-binding-provision")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, tokenLast4: "1234" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as Promise<Response>;
      }
      return Promise.resolve(new Response("OK", { status: 200 })) as Promise<Response>;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    Bun.spawn = origSpawn;
    globalThis.fetch = origFetch;
  });

  it("migrates v1 spec and continues with attach", async () => {
    // Write a v1 spec directly (simulating pre-2A-2 data)
    const v1Content = JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: `${projectName}-${userId}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, null, 2);
    await writeFile(join(instDir, "sidecar-spec.json"), v1Content);

    // Attach should migrate to v2 then execute
    const result = await dispatch("sidecar.attach", basePayload());
    if (!result.ok) { console.log("MIGRATION ATTACH FAIL:", result); }
    expect(result.ok).toBe(true);

    // Verify migrated spec
    const specContent = await readFile(join(instDir, "sidecar-spec.json"), "utf8");
    const spec = JSON.parse(specContent) as SidecarSpec;
    expect(spec.schemaVersion).toBe(2);
    expect(spec.enabled).toBe(true);
    expect(spec.operationId).toBe("op-1"); // current operation overwrites
    expect(spec.managedInstanceId).toBe("sri-1");
  });
});

describe("sidecar.detach v1 migration", () => {
  let origSpawn: typeof Bun.spawn;
  let origFetch: typeof fetch;

  beforeEach(() => {
    origSpawn = Bun.spawn;
    origFetch = globalThis.fetch;
    Bun.spawn = ((args: string[], _opts?: { cwd?: string }) => {
      const cmd = args.join(" ");
      if (cmd.includes("docker inspect")) {
        return {
          exited: Promise.resolve(1),
          stdout: new Blob([args.some(a => a.includes("Health")) ? "healthy" : "true"]).stream(),
          stderr: new Blob(["No such container"]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    globalThis.fetch = ((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("weixin-binding-provision")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, tokenLast4: "1234" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as Promise<Response>;
      }
      return Promise.resolve(new Response("OK", { status: 200 })) as Promise<Response>;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    Bun.spawn = origSpawn;
    globalThis.fetch = origFetch;
  });

  it("migrates v1 spec and continues with detach", async () => {
    const v1Content = JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      serviceName: "weixin-sidecar",
      envFile: ".env.weixin",
      port: 8787,
      composeProject: `${projectName}-${userId}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, null, 2);
    await writeFile(join(instDir, "sidecar-spec.json"), v1Content);

    const result = await dispatch("sidecar.detach", basePayload({
      operationId: "op-2",
      expectedAttachmentVersion: 0,
      expectedConfigVersion: 1,
    }));
    if (!result.ok) { console.log("MIGRATION DETACH FAIL:", result); }
    expect(result.ok).toBe(true);

    const specContent = await readFile(join(instDir, "sidecar-spec.json"), "utf8");
    const spec = JSON.parse(specContent) as SidecarSpec;
    expect(spec.schemaVersion).toBe(2);
    expect(spec.enabled).toBe(false);
    expect(spec.operationId).toBe("op-2");
    expect(spec.desiredAttachmentState).toBe("detached");
  });
});
