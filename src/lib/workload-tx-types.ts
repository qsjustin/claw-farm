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
}

/** Maximum number of rollback error codes to include in metadata */
export const MAX_ROLLBACK_CODES = 5;
