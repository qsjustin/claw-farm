/**
 * #171: Canonical per-instance weixin sidecar spec persistence.
 *
 * The sidecar spec is written to `<instDir>/sidecar-spec.json` during instance
 * create/restore and read by all subsequent lifecycle operations (start, restart,
 * model apply, rebuild). This ensures the sidecar survives compose regeneration
 * even when the caller doesn't pass weixin options explicitly.
 *
 * The spec stores only non-secret metadata — never plaintext tokens.
 *
 * Fail-closed semantics:
 * - A corrupted or invalid spec file is a hard error (throws), not silently disabled.
 * - An enabled spec means the sidecar MUST be present in compose; callers must
 *   ensure rotation inputs (managedInstanceId, clawBayApiUrl, clawBayAdminToken)
 *   are available or fail-closed.
 * - Writing is atomic (temp file + rename) with 0600 permissions.
 */

import { join } from "node:path";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";

const SPEC_FILENAME = "sidecar-spec.json";

export interface SidecarSpec {
  /** Whether the weixin sidecar is enabled for this instance */
  enabled: boolean;
  /** Sidecar service name in compose (default: "weixin-sidecar") */
  serviceName: string;
  /** Env file reference (default: ".env.weixin") */
  envFile: string;
  /** Internal container port (default: 8787) */
  port: number;
  /** External network name (optional) */
  externalNetwork?: string;
  /** Compose project name */
  composeProject: string;
  /** Created/updated timestamp */
  updatedAt: string;
}

class SidecarSpecError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "spec-corrupted"
      | "spec-invalid"
      | "spec-write-failed",
  ) {
    super(message);
    this.name = "SidecarSpecError";
  }
}

/**
 * Validate a parsed spec object. Throws on invalid fields.
 */
function validateSpec(data: unknown): asserts data is SidecarSpec {
  if (typeof data !== "object" || data === null) {
    throw new SidecarSpecError("sidecar spec is not an object", "spec-invalid");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.enabled !== "boolean") {
    throw new SidecarSpecError(
      `sidecar spec 'enabled' must be boolean, got ${typeof obj.enabled}`,
      "spec-invalid",
    );
  }
  if (typeof obj.serviceName !== "string" || obj.serviceName.length === 0) {
    throw new SidecarSpecError(
      "sidecar spec 'serviceName' must be a non-empty string",
      "spec-invalid",
    );
  }
  if (typeof obj.envFile !== "string" || obj.envFile.length === 0) {
    throw new SidecarSpecError(
      "sidecar spec 'envFile' must be a non-empty string",
      "spec-invalid",
    );
  }
  if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
    throw new SidecarSpecError(
      `sidecar spec 'port' must be an integer 1-65535, got ${obj.port}`,
      "spec-invalid",
    );
  }
  if (typeof obj.composeProject !== "string" || obj.composeProject.length === 0) {
    throw new SidecarSpecError(
      "sidecar spec 'composeProject' must be a non-empty string",
      "spec-invalid",
    );
  }
  if (obj.externalNetwork !== undefined && (typeof obj.externalNetwork !== "string" || obj.externalNetwork.length === 0)) {
    throw new SidecarSpecError(
      "sidecar spec 'externalNetwork' must be a non-empty string if present",
      "spec-invalid",
    );
  }
  if (typeof obj.updatedAt !== "string" || obj.updatedAt.length === 0) {
    throw new SidecarSpecError(
      "sidecar spec 'updatedAt' must be a non-empty string",
      "spec-invalid",
    );
  }
}

/**
 * Write the sidecar spec to the instance directory atomically.
 * Called during create/restore when weixin sidecar is provisioned.
 * Uses temp file + rename for atomicity. Permissions set to 0600.
 */
export async function writeSidecarSpec(
  instDir: string,
  spec: SidecarSpec,
): Promise<void> {
  validateSpec(spec);
  const specPath = join(instDir, SPEC_FILENAME);
  const tmpPath = join(instDir, `${SPEC_FILENAME}.tmp`);

  try {
    await writeFile(tmpPath, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, specPath);
  } catch (error) {
    // Clean up temp file if rename failed
    await unlink(tmpPath).catch(() => {});
    throw new SidecarSpecError(
      `Failed to write sidecar spec: ${error instanceof Error ? error.message : String(error)}`,
      "spec-write-failed",
    );
  }
}

/**
 * Read the sidecar spec from the instance directory.
 * Returns null if no spec file exists (pre-#171 instances or sidecar never enabled).
 * Throws SidecarSpecError if the spec exists but is corrupted or invalid.
 */
export async function readSidecarSpec(
  instDir: string,
): Promise<SidecarSpec | null> {
  const specPath = join(instDir, SPEC_FILENAME);
  const file = Bun.file(specPath);
  if (!await file.exists()) {
    return null;
  }
  let data: unknown;
  try {
    data = await file.json();
  } catch {
    throw new SidecarSpecError(
      "sidecar-spec.json exists but contains invalid JSON",
      "spec-corrupted",
    );
  }
  validateSpec(data);
  return data;
}

/**
 * Remove the sidecar spec file (called during full delete with data removal,
 * or when sidecar is explicitly disabled).
 */
export async function removeSidecarSpec(
  instDir: string,
): Promise<void> {
  const specPath = join(instDir, SPEC_FILENAME);
  await unlink(specPath).catch(() => {});
}

/**
 * Check whether a sidecar spec exists and is enabled.
 * Convenience wrapper for lifecycle operations that need a boolean.
 * Returns false if no spec exists. Throws if spec is corrupted.
 */
export async function isSidecarEnabled(
  instDir: string,
): Promise<boolean> {
  const spec = await readSidecarSpec(instDir);
  return spec?.enabled === true;
}

export { SidecarSpecError };
export const SIDECAR_SPEC_FILENAME = SPEC_FILENAME;
