/**
 * #171 Phase 2A-2: Shared workload transaction types.
 *
 * Defines the typed contract between claw-farm (producer) and claw-bay (consumer)
 * for workload transaction rollback/degraded state.
 */

/**
 * Allowlisted rollback error codes.
 * Farm only outputs these stable codes; raw error messages stay local.
 * Bay only accepts codes from this list.
 */
export const ROLLBACK_ERROR_CODES = [
  "target-stop-failed",
  "target-remove-failed",
  "compose-restore-failed",
  "compose-unlink-failed",
  "spec-restore-failed",
  "spec-unlink-failed",
  "workload-restore-failed",
  "revoke-failed",
  "env-restore-failed",
] as const;

export type RollbackErrorCode = typeof ROLLBACK_ERROR_CODES[number];

/**
 * Check if a string is a valid rollback error code.
 */
export function isRollbackErrorCode(code: string): code is RollbackErrorCode {
  return (ROLLBACK_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Workload transaction degraded state metadata.
 * This is the typed contract that goes across the bridge.
 */
export interface WorkloadDegradedMetadata {
  /** Whether rollback was attempted */
  didRollback: boolean;
  /** Allowlisted rollback error codes (max 5) */
  rollbackErrorCodes?: RollbackErrorCode[];
  /** Critical compensation codes that bypass the 5-code limit (always visible) */
  criticalCompensationCodes?: readonly string[];
}

/** Maximum number of rollback error codes to include in metadata */
export const MAX_ROLLBACK_CODES = 5;

/**
 * Critical compensation codes that must always be visible.
 * These cannot be truncated by the 5-code rollback limit because they
 * indicate state that requires follow-up (token/env durability).
 */
export const CRITICAL_COMPENSATION_CODES: readonly string[] = [
  "revoke-failed",
  "env-restore-failed",
] as const;
