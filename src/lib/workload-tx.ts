/**
 * #171 Phase 2A-2: Workload transaction primitive.
 *
 * Fail-closed workload transaction for sidecar attach/detach.
 * Provides: prepare → side-effect → commit/rollback with proper compensation.
 *
 * Design:
 * - prepare: snapshot previous state, fail-closed on corrupt/I/O
 * - side effects: caller-provided closure (compose write/up/down/stop/rm)
 * - commit: atomic spec write via writeSidecarSpec
 * - rollback: compensateTarget (stop+rm new) + restorePrevious (restore spec/compose + restart)
 *
 * IMPORTANT: Token revocation is NOT part of the transaction.
 * It is an irreversible operation performed after successful commit by the caller.
 */

import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import {
  readSidecarSpec,
  writeSidecarSpec,
  SidecarSpecError,
  type SidecarSpec,
} from "./sidecar-spec.ts";

const COMPOSE_FILE = "docker-compose.openclaw.yml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkloadSnapshot {
  previousSpec: SidecarSpec | null;
  previousCompose: string | null;
  wasRunning: boolean;
}

export interface TransactionPlan {
  newSpec: SidecarSpec;
  serviceName: string;
  composeProject: string;
}

export interface TransactionResult {
  committed: boolean;
  /** Side effect or commit error message */
  error?: string;
  /** Any non-fatal restore errors during rollback */
  rollbackErrors: string[];
  /** Whether rollback was needed at all */
  didRollback: boolean;
}

// ---------------------------------------------------------------------------
// Prepare — fail-closed
// ---------------------------------------------------------------------------

/**
 * Read file with fail-closed semantics.
 * Returns null only for ENOENT; throws for corrupt, permission, or I/O errors.
 */
async function readFileSync(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err; // corrupt, permission, I/O — fail-closed
  }
}

/**
 * Write file using the existing atomic sidecar spec writer for spec files,
 * and plain writeFile for compose files (compose has no atomic writer).
 */
async function writeAtomicSpec(instDir: string, spec: SidecarSpec): Promise<void> {
  await writeSidecarSpec(instDir, spec);
}

/**
 * Snapshot the current workload state. Fail-closed: throws on corrupt/I/O.
 */
export async function snapshotWorkload(
  instDir: string,
  composeProject: string,
): Promise<WorkloadSnapshot> {
  const previousSpec = await readSidecarSpec(instDir).catch((err) => {
    // If the spec is corrupt or has I/O errors, propagate the failure
    if (err instanceof SidecarSpecError) {
      if (err.code === "spec-corrupted" || err.code === "spec-invalid") {
        throw err; // fail-closed
      }
      // spec-write-failed or other: treat as absent
      return null;
    }
    throw err; // I/O error — fail-closed
  });

  const previousCompose = await readFileSync(join(instDir, COMPOSE_FILE));
  const wasRunning = await isServiceRunning(composeProject);

  return { previousSpec, previousCompose, wasRunning };
}

/**
 * Check if sidecar container is running via Docker inspect.
 */
async function isServiceRunning(composeProject: string): Promise<boolean> {
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

// ---------------------------------------------------------------------------
// Compensate target — clean up new workload created by this transaction
// ---------------------------------------------------------------------------

/**
 * Stop and remove the sidecar service (compensation for new workload).
 * Best-effort: logs errors but doesn't throw.
 */
async function compensateTarget(
  instDir: string,
  composeProject: string,
  serviceName: string,
): Promise<string[]> {
  const errors: string[] = [];
  const { runComposeService } = await import("./compose.ts");

  try {
    await runComposeService(instDir, "stop", serviceName, {
      quiet: true,
      projectName: composeProject,
    });
  } catch (err) {
    errors.push(`stop failed: ${err instanceof Error ? err.message : err}`);
  }

  try {
    await runComposeService(instDir, "rm", serviceName, {
      quiet: true,
      projectName: composeProject,
    });
  } catch (err) {
    errors.push(`rm failed: ${err instanceof Error ? err.message : err}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Restore previous — restore files and restart previous workload
// ---------------------------------------------------------------------------

/**
 * Restore previous compose and spec files, and restart sidecar if it was running.
 */
async function restorePrevious(
  instDir: string,
  composeProject: string,
  snapshot: WorkloadSnapshot,
): Promise<string[]> {
  const errors: string[] = [];
  const composePath = join(instDir, COMPOSE_FILE);
  const specPath = join(instDir, "sidecar-spec.json");

  // Restore compose
  if (snapshot.previousCompose !== null) {
    try {
      await writeFile(composePath, snapshot.previousCompose, "utf8");
    } catch (err) {
      errors.push(`compose restore failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    try {
      await unlink(composePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        errors.push(`compose unlink failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Restore spec
  if (snapshot.previousSpec !== null) {
    try {
      await writeSidecarSpec(instDir, snapshot.previousSpec);
    } catch (err) {
      errors.push(`spec restore failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    try {
      await unlink(specPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        errors.push(`spec unlink failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Restart previous workload if it was running
  if (snapshot.wasRunning) {
    try {
      const { runComposeService } = await import("./compose.ts");
      const proc = Bun.spawn(
        ["docker", "compose", "-f", composePath, "-p", composeProject, "up", "-d"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        errors.push(`workload restart failed: exit ${exitCode}: ${stderr.trim()}`);
      }
    } catch (err) {
      errors.push(`workload restart error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check container health status via docker inspect.
 * Returns true only if .State.Health.Status === "healthy".
 * Returns false if no Health field (fail-closed) or unhealthy.
 */
export async function checkContainerHealth(
  composeProject: string,
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

// ---------------------------------------------------------------------------
// Execute transaction
// ---------------------------------------------------------------------------

/**
 * Execute a workload transaction: side effects → commit → or rollback.
 *
 * @param instDir - Instance directory
 * @param composeProject - Docker compose project name
 * @param serviceName - Sidecar service name
 * @param plan - Target spec to commit
 * @param sideEffects - Function that performs compose/service side effects.
 *                      Must throw on failure.
 * @param compensateOnSuccess - Optional: function to run on successful commit
 *                              (e.g., detach revoke). If it throws, committed=true
 *                              but compensateError is set.
 */
export async function executeWorkloadTransaction(
  instDir: string,
  composeProject: string,
  serviceName: string,
  plan: TransactionPlan,
  sideEffects: () => Promise<void>,
  compensateOnSuccess?: () => Promise<void>,
): Promise<TransactionResult> {
  // 1. Prepare: snapshot previous state (fail-closed)
  const snapshot = await snapshotWorkload(instDir, composeProject);

  // 2. Execute side effects
  try {
    await sideEffects();
  } catch (error) {
    // Side effect failed: compensate target + restore previous
    const compensateErrors = await compensateTarget(instDir, composeProject, serviceName);
    const restoreErrors = await restorePrevious(instDir, composeProject, snapshot);
    return {
      committed: false,
      error: error instanceof Error ? error.message : String(error),
      rollbackErrors: [...compensateErrors, ...restoreErrors],
      didRollback: true,
    };
  }

  // 3. Commit: write spec atomically
  try {
    await writeSidecarSpec(instDir, plan.newSpec);
  } catch (error) {
    // Commit failed: compensate target + restore previous
    const compensateErrors = await compensateTarget(instDir, composeProject, serviceName);
    const restoreErrors = await restorePrevious(instDir, composeProject, snapshot);
    return {
      committed: false,
      error: `spec commit failed: ${error instanceof Error ? error.message : error}`,
      rollbackErrors: [...compensateErrors, ...restoreErrors],
      didRollback: true,
    };
  }

  // 4. Post-commit compensation (e.g., revoke) — best-effort
  let compensateError: string | undefined;
  if (compensateOnSuccess) {
    try {
      await compensateOnSuccess();
    } catch (error) {
      compensateError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    committed: true,
    error: compensateError,
    rollbackErrors: [],
    didRollback: false,
  };
}
