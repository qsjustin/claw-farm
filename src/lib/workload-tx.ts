/**
 * #171 Phase 2A-2: Workload transaction helper.
 *
 * Shared prepare→side-effect→commit/rollback pattern for attach/detach.
 * Ensures atomicity: sidecar spec is committed only after all side effects succeed.
 * Rollback restores previous spec, compose, and workload state.
 */

import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { COMPOSE_FILENAME } from "../lib/compose.ts";
import {
  readSidecarSpec,
  writeSidecarSpec,
  type SidecarSpec,
} from "../lib/sidecar-spec.ts";

const COMPOSE_FILE = "docker-compose.openclaw.yml";

export interface WorkloadSnapshot {
  /** Previous sidecar spec (null if none existed) */
  previousSpec: SidecarSpec | null;
  /** Previous compose file content (null if none existed) */
  previousCompose: string | null;
  /** Whether sidecar container was running before transaction */
  wasRunning: boolean;
}

export interface TransactionPlan {
  /** Target spec to commit after side effects succeed */
  newSpec: SidecarSpec;
  /** Sidecar service name in compose */
  serviceName: string;
  /** Docker compose project name */
  composeProject: string;
}

/**
 * Snapshot the current workload state for rollback.
 */
export async function snapshotWorkload(
  instDir: string,
  composeProject: string,
  serviceName: string,
): Promise<WorkloadSnapshot> {
  const previousSpec = await readSidecarSpec(instDir).catch(() => null);
  const previousCompose = await readFile(join(instDir, COMPOSE_FILE), "utf8").catch(() => null);
  const wasRunning = await isServiceRunning(composeProject, serviceName);
  return { previousSpec, previousCompose, wasRunning };
}

/**
 * Check if a docker compose service is running via docker inspect.
 */
async function isServiceRunning(composeProject: string, serviceName: string): Promise<boolean> {
  const containerName = `${composeProject}-weixin`;
  try {
    const proc = Bun.spawn(
      ["docker", "inspect", "--format", "{{.State.Running}}", containerName],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    const output = await new Response(proc.stdout).text();
    return output.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Check container health status via docker inspect.
 * Returns true only if .State.Health.Status === "healthy".
 * Returns false if no Health field (fail-closed) or unhealthy.
 */
export async function checkContainerHealth(
  composeProject: string,
  serviceName: string,
): Promise<boolean> {
  const containerName = `${composeProject}-weixin`;
  try {
    const proc = Bun.spawn(
      ["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}", containerName],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    const status = (await new Response(proc.stdout).text()).trim();
    return status === "healthy";
  } catch {
    return false;
  }
}

/**
 * Rollback: restore previous compose + spec + restart workload if it was running.
 * Best-effort: logs errors but doesn't throw (caller decides how to report).
 */
export async function rollbackWorkload(
  instDir: string,
  composeProject: string,
  snapshot: WorkloadSnapshot,
  serviceName: string,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];

  // Restore compose file
  const composePath = join(instDir, COMPOSE_FILE);
  if (snapshot.previousCompose !== null) {
    try {
      await writeFile(composePath, snapshot.previousCompose, "utf8");
    } catch (e) {
      errors.push(`compose restore failed: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    try {
      await unlink(composePath);
    } catch { /* file didn't exist — fine */ }
  }

  // Restore spec file
  const specPath = join(instDir, "sidecar-spec.json");
  if (snapshot.previousSpec !== null) {
    try {
      await writeFile(specPath, JSON.stringify(snapshot.previousSpec, null, 2) + "\n", "utf8");
    } catch (e) {
      errors.push(`spec restore failed: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    try {
      await unlink(specPath);
    } catch { /* file didn't exist — fine */ }
  }

  // If sidecar was running before, try to restart it
  if (snapshot.wasRunning) {
    try {
      const proc = Bun.spawn(
        ["docker", "compose", "-f", composePath, "-p", composeProject, "up", "-d", serviceName],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        errors.push(`workload restart failed: exit ${exitCode}: ${stderr.trim()}`);
      }
    } catch (e) {
      errors.push(`workload restart error: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { errors };
}

/**
 * Execute a workload transaction: side effects → commit → or rollback.
 *
 * @param instDir - Instance directory
 * @param plan - What to commit (new spec + compose)
 * @param sideEffects - Function that performs compose/service side effects.
 *                      Must throw on failure; rollback happens automatically.
 * @returns Commit result with any rollback errors
 */
export async function executeWorkloadTransaction(
  instDir: string,
  composeProject: string,
  serviceName: string,
  plan: TransactionPlan,
  sideEffects: () => Promise<void>,
): Promise<{ committed: boolean; rollbackErrors: string[]; sideEffectError?: string }> {
  // 1. Snapshot previous state
  const snapshot = await snapshotWorkload(instDir, composeProject, serviceName);

  try {
    // 2. Execute side effects (compose write, up/down, health, revoke)
    await sideEffects();
  } catch (error) {
    // Side effect failed — rollback everything
    const { errors: rollbackErrors } = await rollbackWorkload(instDir, composeProject, snapshot, serviceName);
    return {
      committed: false,
      rollbackErrors,
      sideEffectError: error instanceof Error ? error.message : String(error),
    };
  }

  // 3. Commit: write spec only (compose already written by sideEffects)
  const specPath = join(instDir, "sidecar-spec.json");
  try {
    await writeSidecarSpec(instDir, plan.newSpec);
  } catch (error) {
    // Spec write failed — rollback compose + restore previous
    const { errors: rollbackErrors } = await rollbackWorkload(instDir, composeProject, snapshot, serviceName);
    return {
      committed: false,
      rollbackErrors,
      sideEffectError: `spec commit failed: ${error instanceof Error ? error.message : error}`,
    };
  }

  return { committed: true, rollbackErrors: [] };
}
