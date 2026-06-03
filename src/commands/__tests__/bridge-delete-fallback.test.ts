import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bridge instance.delete fallback", () => {
  test("marks stale runtime registry entries deleted when project cleanup cannot resolve", async () => {
    const home = await mkdtemp(join(tmpdir(), "claw-farm-bridge-delete-"));
    const registryDir = join(home, ".claw-farm");
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(registryDir, "runtime-instances.json"),
      JSON.stringify({
        version: 1,
        instances: {
          "missing-project:user-1": {
            runtimeInstanceKey: "missing-project:user-1",
            runtimeType: "hermes",
            project: "missing-project",
            userId: "user-1",
            status: "running",
            composeProject: "missing-project-user-1",
            containerName: "missing-project-user-1-hermes",
            internalPort: 8642,
            hostPort: 18795,
            endpointRef: "claw-farm:missing-project:user-1:endpoint",
            dataVolumeRef: "claw-farm:missing-project:user-1:data",
            workspaceRef: "claw-farm:missing-project:user-1:workspace",
            health: {
              observedAt: null,
              ready: true,
            },
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
            deletedAt: null,
          },
        },
      }),
    );

    const child = Bun.spawn({
      cmd: [
        "bun",
        "src/index.ts",
        "bridge",
        "instance.delete",
        JSON.stringify({
          project: "missing-project",
          userId: "user-1",
          runtimeType: "hermes",
          keepData: true,
          deleteData: false,
        }),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const response = JSON.parse(stdout) as {
      ok: boolean;
      runtimeState: string;
      metadata: {
        dataRetained: boolean;
        dataDeleted: boolean;
        cleanupFallback: boolean;
        cleanupReason: string;
      };
    };
    expect(response.ok).toBe(true);
    expect(response.runtimeState).toBe("deleted");
    expect(response.metadata).toMatchObject({
      dataRetained: true,
      dataDeleted: false,
      cleanupFallback: true,
    });
    expect(response.metadata.cleanupReason).not.toContain("/home/");

    const registry = JSON.parse(await readFile(join(registryDir, "runtime-instances.json"), "utf8")) as {
      instances: Record<string, { status: string; health: { ready: boolean; lastError?: string } }>;
    };
    expect(registry.instances["missing-project:user-1"]?.status).toBe("deleted");
    expect(registry.instances["missing-project:user-1"]?.health.ready).toBe(false);
  });

  test("uses runtime registry project to physically delete stale entries requested through a legacy project", async () => {
    const home = await mkdtemp(join(tmpdir(), "claw-farm-bridge-delete-data-"));
    const registryDir = join(home, ".claw-farm");
    const projectsRoot = join(home, "projects");
    const legacyProjectDir = join(projectsRoot, "clawbay-prod");
    const hermesProjectDir = join(projectsRoot, "clawbay-hermes");
    const userId = "cmp6mpkn9000f68p9yjzyovyj";
    const instanceRoot = join(hermesProjectDir, "instances", userId);
    await mkdir(join(instanceRoot, "hermes", "workspace"), { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(instanceRoot, "user-file.txt"), "retained data");
    await writeFile(
      join(registryDir, "registry.json"),
      JSON.stringify({
        projects: {
          "clawbay-prod": {
            path: legacyProjectDir,
            port: 18790,
            processor: "builtin",
            createdAt: "2026-05-17T00:00:00.000Z",
            multiInstance: true,
            runtime: "openclaw",
            instances: {},
          },
          "clawbay-hermes": {
            path: hermesProjectDir,
            port: 18791,
            processor: "builtin",
            createdAt: "2026-05-17T00:00:00.000Z",
            multiInstance: true,
            runtime: "hermes",
            instances: {
              [userId]: {
                userId,
                port: 18795,
                createdAt: "2026-05-17T00:00:00.000Z",
              },
            },
          },
        },
        nextPort: 18796,
      }),
    );
    await writeFile(
      join(registryDir, "runtime-instances.json"),
      JSON.stringify({
        version: 1,
        instances: {
          [`clawbay-hermes:${userId}`]: {
            runtimeInstanceKey: `clawbay-hermes:${userId}`,
            runtimeType: "hermes",
            project: "clawbay-hermes",
            userId,
            status: "running",
            composeProject: `clawbay-hermes-${userId}`,
            containerName: `clawbay-hermes-${userId}-hermes`,
            internalPort: 8642,
            hostPort: 18795,
            endpointRef: `claw-farm:clawbay-hermes:${userId}:endpoint`,
            dataVolumeRef: `claw-farm:clawbay-hermes:${userId}:data`,
            workspaceRef: `claw-farm:clawbay-hermes:${userId}:workspace`,
            health: {
              observedAt: null,
              ready: true,
            },
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
            deletedAt: null,
          },
        },
      }),
    );

    const child = Bun.spawn({
      cmd: [
        "bun",
        "src/index.ts",
        "bridge",
        "instance.delete",
        JSON.stringify({
          project: "clawbay-prod",
          userId,
          runtimeType: "hermes",
          keepData: false,
          deleteData: true,
        }),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const response = JSON.parse(stdout) as {
      ok: boolean;
      runtimeInstanceKey: string;
      runtimeState: string;
      metadata: {
        dataRetained: boolean;
        dataDeleted: boolean;
        cleanupFallback: boolean;
        requestedProject?: string;
      };
    };
    expect(response.ok).toBe(true);
    expect(response.runtimeInstanceKey).toBe(`clawbay-hermes:${userId}`);
    expect(response.runtimeState).toBe("deleted");
    expect(response.metadata).toMatchObject({
      dataRetained: false,
      dataDeleted: true,
      cleanupFallback: true,
      requestedProject: "clawbay-prod",
    });
    expect(await Bun.file(join(instanceRoot, "user-file.txt")).exists()).toBe(false);

    const registry = JSON.parse(await readFile(join(registryDir, "runtime-instances.json"), "utf8")) as {
      instances: Record<string, { status: string; health: { ready: boolean } }>;
    };
    expect(registry.instances[`clawbay-hermes:${userId}`]).toBeUndefined();
  });

  test("normal instance.delete response metadata does not contain host paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "claw-farm-bridge-delete-normal-"));
    const registryDir = join(home, ".claw-farm");
    const projectsRoot = join(home, "projects");
    const projectDir = join(projectsRoot, "test-proj");
    const userId = "test-user-1";
    const instanceRoot = join(projectDir, "instances", userId);
    await mkdir(join(instanceRoot, "openclaw", "workspace"), { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(registryDir, "registry.json"),
      JSON.stringify({
        projects: {
          "test-proj": {
            path: projectDir,
            port: 18789,
            processor: "builtin",
            createdAt: "2026-05-17T00:00:00.000Z",
            multiInstance: true,
            runtime: "openclaw",
            instances: {
              [userId]: {
                userId,
                port: 18789,
                createdAt: "2026-05-17T00:00:00.000Z",
              },
            },
          },
        },
        nextPort: 18790,
      }),
    );
    await writeFile(
      join(registryDir, "runtime-instances.json"),
      JSON.stringify({
        version: 1,
        instances: {
          [`test-proj:${userId}`]: {
            runtimeInstanceKey: `test-proj:${userId}`,
            runtimeType: "openclaw",
            project: "test-proj",
            userId,
            status: "running",
            composeProject: `test-proj-${userId}`,
            containerName: `test-proj-${userId}-openclaw`,
            internalPort: 18789,
            hostPort: 18789,
            endpointRef: `claw-farm:test-proj:${userId}:endpoint`,
            dataVolumeRef: `claw-farm:test-proj:${userId}:data`,
            workspaceRef: `claw-farm:test-proj:${userId}:workspace`,
            health: {
              observedAt: "2026-05-17T00:00:00.000Z",
              ready: true,
            },
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
            deletedAt: null,
          },
        },
      }),
    );

    // Test deleteData=true path
    const child = Bun.spawn({
      cmd: [
        "bun",
        "src/index.ts",
        "bridge",
        "instance.delete",
        JSON.stringify({
          project: "test-proj",
          userId,
          deleteData: true,
        }),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const response = JSON.parse(stdout) as {
      ok: boolean;
      action: string;
      runtimeState: string;
      metadata: Record<string, unknown>;
    };
    expect(response.ok).toBe(true);
    expect(response.action).toBe("instance.delete");
    expect(response.runtimeState).toBe("deleted");

    // Core assertion: metadata must not contain host paths
    const metadataStr = JSON.stringify(response.metadata);
    expect(metadataStr).not.toContain("/home/");
    expect(metadataStr).not.toContain("/tmp/");
    expect(metadataStr).not.toContain("workspacePath");
    expect(metadataStr).not.toContain("instanceRoot");
    expect(metadataStr).not.toContain("workspaceRoot");

    // Functional assertions: dataDeleted/dataRetained still correct
    expect(response.metadata.dataDeleted).toBe(true);
    expect(response.metadata.dataRetained).toBe(false);

    // Test deleteData=false (keep data) path
    // Re-create the instance directory and registry for the second test
    await mkdir(join(instanceRoot, "openclaw", "workspace"), { recursive: true });
    await writeFile(
      join(registryDir, "runtime-instances.json"),
      JSON.stringify({
        version: 1,
        instances: {
          [`test-proj:${userId}`]: {
            runtimeInstanceKey: `test-proj:${userId}`,
            runtimeType: "openclaw",
            project: "test-proj",
            userId,
            status: "running",
            composeProject: `test-proj-${userId}`,
            containerName: `test-proj-${userId}-openclaw`,
            internalPort: 18789,
            hostPort: 18789,
            endpointRef: `claw-farm:test-proj:${userId}:endpoint`,
            dataVolumeRef: `claw-farm:test-proj:${userId}:data`,
            workspaceRef: `claw-farm:test-proj:${userId}:workspace`,
            health: {
              observedAt: "2026-05-17T00:00:00.000Z",
              ready: true,
            },
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
            deletedAt: null,
          },
        },
      }),
    );

    const child2 = Bun.spawn({
      cmd: [
        "bun",
        "src/index.ts",
        "bridge",
        "instance.delete",
        JSON.stringify({
          project: "test-proj",
          userId,
          deleteData: false,
        }),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout2, stderr2, exitCode2] = await Promise.all([
      new Response(child2.stdout).text(),
      new Response(child2.stderr).text(),
      child2.exited,
    ]);

    expect(stderr2).toBe("");
    expect(exitCode2).toBe(0);
    const response2 = JSON.parse(stdout2) as {
      ok: boolean;
      metadata: Record<string, unknown>;
    };
    expect(response2.ok).toBe(true);

    const metadataStr2 = JSON.stringify(response2.metadata);
    expect(metadataStr2).not.toContain("/home/");
    expect(metadataStr2).not.toContain("/tmp/");
    expect(metadataStr2).not.toContain("workspacePath");
    expect(response2.metadata.dataDeleted).toBe(false);
    expect(response2.metadata.dataRetained).toBe(true);
  });
});
