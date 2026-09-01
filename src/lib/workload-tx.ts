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
import type { RollbackErrorCode } from "./workload-tx-types.ts";
import { MAX_ROLLBACK_CODES, ROLLBACK_ERROR_CODES, CRITICAL_COMPENSATION_CODES } from "./workload-tx-types.ts";

const COMPOSE_FILE = "docker-compose.openclaw.yml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkloadSnapshot {
  previousSpec: SidecarSpec | null;
  previousCompose: string | null;
  /** Running state for every service replaced by this transaction. */
  runningServices?: Record<string, boolean>;
  /** Compatibility alias for the historical sidecar-only transaction. */
  wasRunning: boolean;
}

export interface TransactionPlan {
  newSpec: SidecarSpec;
  serviceName: string;
  composeProject: string;
  /** Ordered services replaced together; gateway precedes sidecar when present. */
  serviceNames?: readonly string[];
  /** Reject instance-local Compose override for immutable paired runtime work. */
  allowComposeOverride?: boolean;
}

export interface TransactionResult {
  committed: boolean;
  /** Side effect or commit error message */
  error?: string;
  /** Allowlisted rollback error codes */
  rollbackErrorCodes: RollbackErrorCode[];
  /** Critical compensation codes that bypass the rollback limit */
  criticalCompensationCodes?: readonly string[];
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
  serviceNames: readonly string[] = ["weixin-sidecar"],
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
  const runningServices: Record<string, boolean> = {};
  for (const serviceName of serviceNames) {
    runningServices[serviceName] = await isServiceRunning(composeProject, serviceName);
  }
  const wasRunning = runningServices["weixin-sidecar"] ?? false;

  return { previousSpec, previousCompose, runningServices, wasRunning };
}

/**
 * Check if sidecar container is running via Docker inspect.
 */
function serviceContainerName(composeProject: string, serviceName: string): string {
  if (serviceName === "weixin-sidecar") return `${composeProject}-weixin`;
  if (serviceName === "openclaw-gateway") return `${composeProject}-openclaw`;
  return `${composeProject}-${serviceName}`;
}

async function isServiceRunning(composeProject: string, serviceName: string): Promise<boolean> {
  const containerName = serviceContainerName(composeProject, serviceName);
  const proc = Bun.spawn(
    ["docker", "inspect", "--format", "{{.State.Running}}", containerName],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  const stdout = await new Response(proc.stdout).text();

  if (exitCode === 0) {
    return stdout.trim() === "true";
  }
  // Non-zero exit: only allow Docker's exact "No such object" or "No such container" as absent;
  // Other errors (daemon, permission, I/O) → fail-closed
  if (stderr.includes("No such object") || stderr.includes("No such container")) {
    return false; // container genuinely doesn't exist
  }
  throw new Error(`docker inspect failed: exit ${exitCode}: ${stderr.trim() || stdout.trim()}`);
}

// ---------------------------------------------------------------------------
// Compensate target — clean up new workload created by this transaction
// ---------------------------------------------------------------------------

/**
 * Stop and remove the sidecar service (compensation for new workload).
 * Best-effort: logs errors but doesn't throw.
 */
export async function compensateTarget(
  instDir: string,
  composeProject: string,
  serviceName: string,
  serviceNamesOrDeps:
    | readonly string[]
    | { runComposeService?: typeof import("./compose.ts").runComposeService } = [serviceName],
  maybeDeps?: { runComposeService?: typeof import("./compose.ts").runComposeService },
  composeOptions?: { allowOverride?: boolean },
): Promise<RollbackErrorCode[]> {
  const codes: RollbackErrorCode[] = [];
  // Preserve the historical fourth-argument dependency injection shape for
  // callers/tests while allowing a multi-service replacement plan.
  const serviceNames = Array.isArray(serviceNamesOrDeps) ? serviceNamesOrDeps : [serviceName];
  const deps = Array.isArray(serviceNamesOrDeps)
    ? maybeDeps
    : serviceNamesOrDeps as { runComposeService?: typeof import("./compose.ts").runComposeService };
  const runCompose = deps?.runComposeService ?? (await import("./compose.ts")).runComposeService;

  for (const targetService of [...serviceNames].reverse()) {
    try {
      await runCompose(instDir, "stop", targetService, {
        quiet: true,
        projectName: composeProject,
        allowOverride: composeOptions?.allowOverride,
      });
    } catch {
      codes.push("target-stop-failed");
    }

    try {
      await runCompose(instDir, "rm", targetService, {
        quiet: true,
        projectName: composeProject,
        allowOverride: composeOptions?.allowOverride,
      });
    } catch {
      codes.push("target-remove-failed");
    }
  }

  return codes.slice(0, MAX_ROLLBACK_CODES);
}

// ---------------------------------------------------------------------------
// Restore previous — restore files and restart previous workload
// ---------------------------------------------------------------------------

/**
 * Restore previous compose and spec files, and restart sidecar if it was running.
 */
export async function restorePrevious(
  instDir: string,
  composeProject: string,
  snapshot: WorkloadSnapshot,
  serviceNames: readonly string[] = ["weixin-sidecar"],
  composeOptions?: { allowOverride?: boolean },
): Promise<RollbackErrorCode[]> {
  const codes: RollbackErrorCode[] = [];
  const composePath = join(instDir, COMPOSE_FILE);
  const specPath = join(instDir, "sidecar-spec.json");

  // Restore compose
  if (snapshot.previousCompose !== null) {
    try {
      await writeFile(composePath, snapshot.previousCompose, "utf8");
    } catch (err) {
      codes.push("compose-restore-failed");
    }
  } else {
    try {
      await unlink(composePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        codes.push("compose-unlink-failed");
      }
    }
  }

  // Restore spec
  if (snapshot.previousSpec !== null) {
    try {
      await writeSidecarSpec(instDir, snapshot.previousSpec);
    } catch (err) {
      codes.push("spec-restore-failed");
    }
  } else {
    try {
      await unlink(specPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        codes.push("spec-unlink-failed");
      }
    }
  }

  // Restart each previous workload in dependency order (service-scoped, not
  // a full instance restart). `wasRunning` preserves the old sidecar-only
  // snapshot shape for callers that predate runningServices.
  for (const serviceName of serviceNames) {
    if (!(snapshot.runningServices?.[serviceName] ?? (serviceName === "weixin-sidecar" && snapshot.wasRunning))) {
      continue;
    }
    try {
      const { runComposeService } = await import("./compose.ts");
      await runComposeService(instDir, "up", serviceName, {
        quiet: true,
        projectName: composeProject,
        allowOverride: composeOptions?.allowOverride,
      });
    } catch {
      codes.push("workload-restore-failed");
    }
  }

  return codes.slice(0, MAX_ROLLBACK_CODES);
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
  const serviceNames = plan.serviceNames?.length ? plan.serviceNames : [serviceName];
  const composeOptions = { allowOverride: plan.allowComposeOverride };
  const snapshot = await snapshotWorkload(instDir, composeProject, serviceNames);

  // 2. Execute side effects
  try {
    await sideEffects();
  } catch (error) {
    // Side effect failed: compensate target + restore previous
    const compensateErrors = await compensateTarget(instDir, composeProject, serviceName, serviceNames, undefined, composeOptions);
    const restoreErrors = await restorePrevious(instDir, composeProject, snapshot, serviceNames, composeOptions);
    // Merge with error-attached rollback codes (e.g., revoke-failed, env-restore-failed)
    const VALID_CODES = new Set<string>(ROLLBACK_ERROR_CODES);
    const attachedCodes = ((error as Error & { rollbackErrorCodes?: readonly string[] })?.rollbackErrorCodes ?? [])
      .filter((c): c is RollbackErrorCode => VALID_CODES.has(c));
    const allCodes = [...compensateErrors, ...restoreErrors, ...attachedCodes];
    // Separate critical compensation codes (token/env) from regular rollback
    const criticalSet = new Set<string>(CRITICAL_COMPENSATION_CODES);
    const criticalAttached = attachedCodes.filter((c) => criticalSet.has(c));
    return {
      committed: false,
      error: error instanceof Error ? error.message : String(error),
      rollbackErrorCodes: Array.from(new Set(allCodes)).slice(0, MAX_ROLLBACK_CODES),
      criticalCompensationCodes: criticalAttached.length > 0 ? criticalAttached : undefined,
      didRollback: true,
    };
  }

  // 3. Commit: write spec atomically
  try {
    await writeSidecarSpec(instDir, plan.newSpec);
  } catch (error) {
    // Commit failed: compensate target + restore previous
    const compensateErrors = await compensateTarget(instDir, composeProject, serviceName, serviceNames, undefined, composeOptions);
    const restoreErrors = await restorePrevious(instDir, composeProject, snapshot, serviceNames, composeOptions);
    return {
      committed: false,
      error: `spec commit failed: ${error instanceof Error ? error.message : error}`,
      rollbackErrorCodes: [...compensateErrors, ...restoreErrors].slice(0, MAX_ROLLBACK_CODES),
      didRollback: true,
    };
  }

  // 4. Post-commit compensation (e.g., revoke) — best-effort
  let compensateError: string | undefined;
  let criticalAttached: string[] = [];
  if (compensateOnSuccess) {
    try {
      await compensateOnSuccess();
    } catch (error) {
      compensateError = error instanceof Error ? error.message : String(error);
      // Extract critical compensation codes from error
      const criticalSet = new Set<string>(CRITICAL_COMPENSATION_CODES);
      const attached = (error as Error & { rollbackErrorCodes?: readonly string[] })?.rollbackErrorCodes ?? [];
      criticalAttached = attached.filter((c) => criticalSet.has(c));
    }
  }

  return {
    committed: true,
    error: compensateError,
    rollbackErrorCodes: [],
    criticalCompensationCodes: criticalAttached.length > 0 ? criticalAttached : undefined,
    didRollback: false,
  };
}
