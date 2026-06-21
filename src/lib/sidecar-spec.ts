/**
 * #171: Canonical per-instance weixin sidecar spec persistence.
 *
 * The sidecar spec is written to `<instDir>/sidecar-spec.json` during instance
 * create/restore and read by all subsequent lifecycle operations (start, restart,
 * model apply, rebuild). This ensures the sidecar survives compose regeneration
 * even when the caller doesn't pass weixin options explicitly.
 *
 * The spec stores only non-secret metadata — never plaintext tokens.
 */

import { join } from "node:path";
import { chmod } from "node:fs/promises";

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
  /** External network name (if any) */
  externalNetwork?: string;
  /** Compose project name */
  composeProject: string;
  /** Created/updated timestamp */
  updatedAt: string;
}

/**
 * Write the sidecar spec to the instance directory.
 * Called during create/restore when weixin sidecar is provisioned.
 */
export async function writeSidecarSpec(
  instDir: string,
  spec: SidecarSpec,
): Promise<void> {
  const specPath = join(instDir, SPEC_FILENAME);
  await Bun.write(specPath, JSON.stringify(spec, null, 2) + "\n");
  await chmod(specPath, 0o644); // Readable by compose, no secrets inside
}

/**
 * Read the sidecar spec from the instance directory.
 * Returns null if no spec exists (pre-#171 instances or sidecar not enabled).
 */
export async function readSidecarSpec(
  instDir: string,
): Promise<SidecarSpec | null> {
  const specPath = join(instDir, SPEC_FILENAME);
  const file = Bun.file(specPath);
  if (!await file.exists()) {
    return null;
  }
  try {
    const data = await file.json();
    if (typeof data !== "object" || data === null) return null;
    if (typeof data.enabled !== "boolean") return null;
    return data as SidecarSpec;
  } catch {
    return null;
  }
}

/**
 * Remove the sidecar spec file (called during full delete with data removal).
 */
export async function removeSidecarSpec(
  instDir: string,
): Promise<void> {
  const specPath = join(instDir, SPEC_FILENAME);
  const file = Bun.file(specPath);
  if (await file.exists()) {
    await Bun.write(specPath, ""); // Truncate first to avoid partial reads
    const { unlink } = await import("node:fs/promises");
    await unlink(specPath).catch(() => {});
  }
}

/**
 * Check whether a sidecar spec exists and is enabled.
 * Convenience wrapper for lifecycle operations that need a boolean.
 */
export async function isSidecarEnabled(
  instDir: string,
): Promise<boolean> {
  const spec = await readSidecarSpec(instDir);
  return spec?.enabled === true;
}

export const SIDECAR_SPEC_FILENAME = SPEC_FILENAME;
