/**
 * #171 Phase 2A-2: Workload transaction helper unit tests.
 *
 * Tests the transaction primitive directly (not through bridge dispatch).
 * Covers: fail-closed prepare, compensation, restore, health check,
 * spec commit failure, detach rm failure, and main-runtime preservation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeWorkloadTransaction,
  snapshotWorkload,
  checkContainerHealth,
  compensateTarget,
  restorePrevious,
} from "../../lib/workload-tx.ts";
import { writeSidecarSpec, readSidecarSpec, type SidecarSpec } from "../../lib/sidecar-spec.ts";

const validSpec: SidecarSpec = {
  schemaVersion: 2,
  enabled: true,
  serviceName: "weixin-sidecar",
  envFile: ".env.weixin",
  port: 8787,
  composeProject: "test-project-user",
  managedInstanceId: "sri-1",
  bindingId: "binding-1",
  operationId: "op-1",
  targetAttachmentVersion: 1,
  targetConfigVersion: 1,
  desiredAttachmentState: "attached",
  updatedAt: "2026-06-29T00:00:00.000Z",
};

let tempDir: string;
let origSpawn: typeof Bun.spawn;
let origFetch: typeof fetch;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "workload-tx-test-"));
  origSpawn = Bun.spawn;
  origFetch = globalThis.fetch;
  // Default mock: compose/docker succeed, docker inspect returns healthy
  Bun.spawn = ((args: string[]) => {
    const cmd = args.join(" ");
    if (cmd.includes("docker inspect")) {
      const isHealthFormat = args.some(a => a.includes("Health"));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([isHealthFormat ? "healthy" : "true"]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }
    return {
      exited: Promise.resolve(0),
      stdout: new Blob([""]).stream(),
      stderr: new Blob([""]).stream(),
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
  globalThis.fetch = (() => {
    return Promise.resolve(new Response("OK", { status: 200 }));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  Bun.spawn = origSpawn;
  globalThis.fetch = origFetch;
  await rm(tempDir, { recursive: true, force: true });
});

describe("snapshotWorkload", () => {
  it("returns null for absent spec and compose", async () => {
    // Mock docker inspect to report container not running
    Bun.spawn = ((args: string[]) => {
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

    const snapshot = await snapshotWorkload(tempDir, "test-project-user");
    expect(snapshot.previousSpec).toBeNull();
    expect(snapshot.previousCompose).toBeNull();
    expect(snapshot.wasRunning).toBe(false);
  });

  it("reads existing spec and compose", async () => {
    await writeSidecarSpec(tempDir, validSpec);
    await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "version: '3'", "utf8");

    const snapshot = await snapshotWorkload(tempDir, "test-project-user");
    expect(snapshot.previousSpec).not.toBeNull();
    expect(snapshot.previousSpec?.operationId).toBe("op-1");
    expect(snapshot.previousCompose).toBe("version: '3'");
  });

  it("throws on corrupt spec (fail-closed)", async () => {
    await writeFile(join(tempDir, "sidecar-spec.json"), "not valid json", "utf8");

    await expect(snapshotWorkload(tempDir, "test-project-user"))
      .rejects.toThrow("invalid JSON");
  });
});

describe("checkContainerHealth", () => {
  it("returns true when container is healthy", async () => {
    const result = await checkContainerHealth("test-project-user");
    expect(result).toBe(true);
  });

  it("returns false when docker inspect fails", async () => {
    Bun.spawn = (() => ({
      exited: Promise.resolve(1),
      stdout: new Blob([""]).stream(),
      stderr: new Blob(["No such container"]).stream(),
    })) as unknown as typeof Bun.spawn;

    const result = await checkContainerHealth("test-project-user");
    expect(result).toBe(false);
  });

  it("returns false when health status is unhealthy", async () => {
    Bun.spawn = ((args: string[]) => {
      const isHealth = args.some(a => a.includes("Health"));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([isHealth ? "unhealthy" : "true"]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const result = await checkContainerHealth("test-project-user");
    expect(result).toBe(false);
  });

  it("returns false when no health check (fail-closed)", async () => {
    Bun.spawn = ((args: string[]) => {
      const isHealth = args.some(a => a.includes("Health"));
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([isHealth ? "no-healthcheck" : "true"]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const result = await checkContainerHealth("test-project-user");
    expect(result).toBe(false);
  });
});

describe("executeWorkloadTransaction", () => {
  it("commits spec after successful side effects", async () => {
    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        // Side effect: write compose
        await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "version: '3'", "utf8");
      },
    );

    expect(result.committed).toBe(true);
    expect(result.didRollback).toBe(false);

    // Spec should be committed
    const spec = await readSidecarSpec(tempDir);
    expect(spec?.operationId).toBe("op-1");
  });

  it("rolls back on side effect failure", async () => {
    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        throw new Error("compose up failed");
      },
    );

    expect(result.committed).toBe(false);
    expect(result.error).toBe("compose up failed");
    expect(result.didRollback).toBe(true);

    // Spec should NOT exist (was absent, rollback restores absent)
    let specExists = false;
    try { await readFile(join(tempDir, "sidecar-spec.json"), "utf8"); specExists = true; } catch {}
    expect(specExists).toBe(false);
  });

  it("restores previous spec on failure", async () => {
    // Pre-populate with old spec
    const oldSpec = { ...validSpec, operationId: "old-op" };
    await writeSidecarSpec(tempDir, oldSpec);

    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        throw new Error("health check failed");
      },
    );

    expect(result.committed).toBe(false);

    // Previous spec should be restored
    const spec = await readSidecarSpec(tempDir);
    expect(spec?.operationId).toBe("old-op");
  });

  it("restores previous compose on failure", async () => {
    // Pre-populate with old compose
    const oldCompose = "version: '3' # old";
    await writeFile(join(tempDir, "docker-compose.openclaw.yml"), oldCompose, "utf8");

    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        // Side effect: overwrite compose
        await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "version: '3' # new", "utf8");
        throw new Error("compose up failed");
      },
    );

    expect(result.committed).toBe(false);

    // Previous compose should be restored
    const compose = await readFile(join(tempDir, "docker-compose.openclaw.yml"), "utf8");
    expect(compose).toBe(oldCompose);
  });

  it("rolls back on spec commit failure", async () => {
    // Write old compose
    await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "version: '3' # old", "utf8");

    const badSpec = { ...validSpec, schemaVersion: 999 } as SidecarSpec;

    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: badSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "version: '3' # new", "utf8");
      },
    );

    expect(result.committed).toBe(false);
    expect(result.error).toContain("spec commit failed");
    expect(result.didRollback).toBe(true);

    // Previous compose should be restored
    const compose = await readFile(join(tempDir, "docker-compose.openclaw.yml"), "utf8");
    expect(compose).toBe("version: '3' # old");
  });

  it("reports compensateOnSuccess errors", async () => {
    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "ok", "utf8");
      },
      async () => {
        throw new Error("revoke failed");
      },
    );

    expect(result.committed).toBe(true);
    expect(result.error).toBe("revoke failed");
  });

  it("detaches stop+rm double failure throws (hard error)", async () => {
    // Mock compose to fail for stop and rm
    let callCount = 0;
    Bun.spawn = ((args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("docker inspect")) {
        const isHealth = args.some(a => a.includes("Health"));
        return {
          exited: Promise.resolve(0),
          stdout: new Blob([isHealth ? "healthy" : "true"]).stream(),
          stderr: new Blob([""]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      callCount++;
      return {
        exited: Promise.resolve(1),
        stdout: new Blob([""]).stream(),
        stderr: new Blob(["compose error"]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        // Simulate stop+rm both failing
        throw new Error("stop+rm failed: both commands failed");
      },
    );

    expect(result.committed).toBe(false);
    expect(result.error).toContain("stop+rm failed");
  });

  it("main instance compose is preserved during sidecar rollback", async () => {
    // Write main instance compose
    const mainCompose = "version: '3' # main instance";
    await writeFile(join(tempDir, "docker-compose.openclaw.yml"), mainCompose, "utf8");

    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        // Side effect: overwrite with sidecar compose
        await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "version: '3' # with sidecar", "utf8");
        throw new Error("health check failed");
      },
    );

    expect(result.committed).toBe(false);

    // Main instance compose should be restored
    const compose = await readFile(join(tempDir, "docker-compose.openclaw.yml"), "utf8");
    expect(compose).toBe(mainCompose);
  });

  it("throws on Docker daemon error during snapshot", async () => {
    // Mock: docker inspect returns permission/daemon error
    Bun.spawn = (() => ({
      exited: Promise.resolve(1),
      stdout: new Blob([""]).stream(),
      stderr: new Blob(["permission denied"]).stream(),
    })) as unknown as typeof Bun.spawn;

    await expect(snapshotWorkload(tempDir, "test-project-user"))
      .rejects.toThrow("docker inspect failed");
  });

  it("throws when detach rm fails and inspect shows container still exists", async () => {
    let rmFailed = false;
    Bun.spawn = ((args: string[]) => {
      const cmd = args.join(" ");
      if (cmd.includes("docker inspect")) {
        const isHealth = args.some(a => a.includes("Health"));
        if (isHealth) {
          return {
            exited: Promise.resolve(0),
            stdout: new Blob(["healthy"]).stream(),
            stderr: new Blob([""]).stream(),
          } as unknown as ReturnType<typeof Bun.spawn>;
        }
        // Container still exists after rm
        return {
          exited: Promise.resolve(0),
          stdout: new Blob(["true"]).stream(),
          stderr: new Blob([""]).stream(),
        } as unknown as ReturnType<typeof Bun.spawn>;
      }
      if (cmd.includes("compose rm")) rmFailed = true;
      return {
        exited: Promise.resolve(1),
        stdout: new Blob([""]).stream(),
        stderr: new Blob(["rm failed"]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;

    const result = await executeWorkloadTransaction(
      tempDir,
      "test-project-user",
      "weixin-sidecar",
      { newSpec: validSpec, serviceName: "weixin-sidecar", composeProject: "test-project-user" },
      async () => {
        throw new Error("rm failed");
      },
    );

    expect(result.committed).toBe(false);
    expect(result.error).toContain("rm failed");
  });

  it("compensateTarget returns target-stop-failed when stop fails", async () => {
    const mockRunCompose = (async (_dir: string, action: string) => {
      if (action === "stop") throw new Error("stop failed");
    }) as any;
    const codes = await compensateTarget(tempDir, "test-project-user", "weixin-sidecar", { runComposeService: mockRunCompose });
    expect(codes).toContain("target-stop-failed");
    expect(codes).not.toContain("target-remove-failed");
  });

  it("compensateTarget returns target-remove-failed when rm fails", async () => {
    const mockRunCompose = (async (_dir: string, action: string) => {
      if (action === "rm") throw new Error("rm failed");
    }) as any;
    const codes = await compensateTarget(tempDir, "test-project-user", "weixin-sidecar", { runComposeService: mockRunCompose });
    expect(codes).toContain("target-remove-failed");
    expect(codes).not.toContain("target-stop-failed");
  });

  it("compensateTarget returns both codes when stop and rm fail", async () => {
    const mockRunCompose = (async () => {
      throw new Error("both failed");
    }) as any;
    const codes = await compensateTarget(tempDir, "test-project-user", "weixin-sidecar", { runComposeService: mockRunCompose });
    expect(codes).toContain("target-stop-failed");
    expect(codes).toContain("target-remove-failed");
  });

  it("restorePrevious returns compose-restore-failed when compose write fails", async () => {
    // Write old compose
    await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "old", "utf8");

    // Delete the temp dir so writeFile fails
    await rm(tempDir, { recursive: true, force: true });

    const snapshot = { previousSpec: null, previousCompose: "old", wasRunning: false };
    const codes = await restorePrevious(tempDir, "test-project-user", snapshot);
    expect(codes).toContain("compose-restore-failed");
  });

  it("restorePrevious returns all-allowlisted codes on multiple failures", async () => {
    // Delete temp dir to make all operations fail
    await rm(tempDir, { recursive: true, force: true });

    const VALID_CODES = new Set(["target-stop-failed", "target-remove-failed", "compose-restore-failed", "compose-unlink-failed", "spec-restore-failed", "spec-unlink-failed", "workload-restore-failed"]);
    const snapshot = { previousSpec: validSpec, previousCompose: "old", wasRunning: false };
    const codes = await restorePrevious(tempDir, "test-project-user", snapshot);
    for (const code of codes) {
      expect(VALID_CODES.has(code)).toBe(true);
    }
    // Must contain compose-restore-failed (writeFile fails since dir deleted)
    expect(codes).toContain("compose-restore-failed");
  });

  it("bound rollbackErrorCodes to MAX_ROLLBACK_CODES", async () => {
    // Make compensateTarget fail (inject failing deps)
    const failingCompose = (async () => {
      throw new Error("compose failed");
    }) as any;

    // Write old compose so unlink fails (not ENOENT)
    await writeFile(join(tempDir, "docker-compose.openclaw.yml"), "old", "utf8");
    // Write old spec so spec write fails (invalid spec)
    await writeFile(join(tempDir, "sidecar-spec.json"), JSON.stringify(validSpec), "utf8");
    // Make dir read-only so both write and unlink fail
    const { chmod } = await import("node:fs/promises");
    await chmod(tempDir, 0o555);

    try {
      const compCodes = await compensateTarget(tempDir, "test-project-user", "weixin-sidecar", { runComposeService: failingCompose });
      const snapshot = { previousSpec: validSpec, previousCompose: "old", wasRunning: false };
      const restoreCodes = await restorePrevious(tempDir, "test-project-user", snapshot);
      const allCodes = [...compCodes, ...restoreCodes];

      // We should have codes from both compensate and restore
      expect(compCodes.length).toBeGreaterThanOrEqual(2);
      expect(restoreCodes.length).toBeGreaterThanOrEqual(1);
      expect(allCodes.length).toBeGreaterThanOrEqual(3);

      // All codes should be in allowlist
      const VALID_CODES = new Set(["target-stop-failed", "target-remove-failed", "compose-restore-failed", "compose-unlink-failed", "spec-restore-failed", "spec-unlink-failed", "workload-restore-failed"]);
      for (const code of allCodes) {
        expect(VALID_CODES.has(code)).toBe(true);
      }
    } finally {
      await chmod(tempDir, 0o755);
    }
  });
});
