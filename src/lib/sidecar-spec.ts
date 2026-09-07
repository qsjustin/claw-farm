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
import { chmod, rename, unlink, writeFile, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isSafeYamlIdentifier } from "./validate.ts";
import { isImmutableImageDigestReference } from "./weixin-runtime-profile.ts";

const SPEC_FILENAME = "sidecar-spec.json";
const SCHEMA_VERSION = 2;

export interface SidecarSpec {
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** Whether the weixin sidecar is enabled for this instance */
  enabled: boolean;
  /** Sidecar service name in compose (fixed: "weixin-sidecar") */
  serviceName: string;
  /** Env file reference (fixed: ".env.weixin") */
  envFile: string;
  /** Internal container port (fixed: 8787) */
  port: number;
  /** External network name (optional, Docker-safe) */
  externalNetwork?: string;
  /** #179: Farm-authoritative alias bound to this SRI + generation. */
  networkAlias?: string;
  aliasGeneration?: number;
  /** Whether this instance was attached with the immutable gateway-binding profile. */
  gatewayBinding?: boolean;
  /** Pinned image pair persisted with gatewayBinding to prevent silent drift on rebuild. */
  gatewayBindingSidecarImage?: string;
  gatewayBindingGatewayImage?: string;
  /** SHA-256 of the generated paired-runtime Compose file. */
  gatewayBindingComposeSha256?: string;

  /**
   * #171 Phase 2A-2: ClawBay SRI (Service Runtime Instance) ID.
   * Used for CAS identity verification — fail-closed if mismatch.
   */
  managedInstanceId: string;
  /**
   * #171 Phase 2A-2: Binding ID from ClawBay CAS.
   * Used for stale replay detection.
   */
  bindingId: string;
  /**
   * #171 Phase 2A-2: Last applied operation ID.
   * Used for idempotency — same operationId = same result (no-op).
   */
  operationId: string;
  /**
   * #171 Phase 2A-2: Target attachment version for CAS.
   * Reject older-version operations (fail-closed).
   */
  targetAttachmentVersion: number;
  /**
   * #171 Phase 2A-2: Target config version for CAS.
   */
  targetConfigVersion: number;
  /**
   * #171 Phase 2A-2: Desired attachment state ("attached" | "detached").
   */
  desiredAttachmentState: "attached" | "detached";
  /** Compose project name (Docker-safe) */
  composeProject: string;

  /** Created/updated timestamp (ISO 8601) */
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

  // Schema version: only accept current v2
  // v1 is no longer valid — use migrateSidecarSpec() for explicit backfill
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    throw new SidecarSpecError(
      `sidecar spec schemaVersion must be ${SCHEMA_VERSION}, got ${JSON.stringify(obj.schemaVersion)}`,
      "spec-invalid",
    );
  }

  if (typeof obj.enabled !== "boolean") {
    throw new SidecarSpecError(
      `sidecar spec 'enabled' must be boolean, got ${typeof obj.enabled}`,
      "spec-invalid",
    );
  }

  // serviceName must be exactly "weixin-sidecar"
  if (obj.serviceName !== "weixin-sidecar") {
    throw new SidecarSpecError(
      `sidecar spec 'serviceName' must be "weixin-sidecar", got ${JSON.stringify(obj.serviceName)}`,
      "spec-invalid",
    );
  }

  // envFile must be exactly ".env.weixin" (basename only, no path traversal)
  if (obj.envFile !== ".env.weixin") {
    throw new SidecarSpecError(
      `sidecar spec 'envFile' must be ".env.weixin", got ${JSON.stringify(obj.envFile)}`,
      "spec-invalid",
    );
  }

  // port must be exactly 8787 (fixed internal port)
  if (obj.port !== 8787) {
    throw new SidecarSpecError(
      `sidecar spec 'port' must be 8787, got ${obj.port}`,
      "spec-invalid",
    );
  }

  // composeProject must be Docker-safe: alphanumeric + dash + underscore, max 128
  if (typeof obj.composeProject !== "string" || !/^[a-zA-Z0-9_-]+$/.test(obj.composeProject) || obj.composeProject.length > 128) {
    throw new SidecarSpecError(
      `sidecar spec 'composeProject' must be Docker-safe (alphanumeric/dash/underscore, max 128), got ${JSON.stringify(obj.composeProject)}`,
      "spec-invalid",
    );
  }

  // externalNetwork must be Docker-safe if present
  if (obj.externalNetwork !== undefined) {
    if (typeof obj.externalNetwork !== "string" || !/^[a-zA-Z0-9_-]+$/.test(obj.externalNetwork) || obj.externalNetwork.length > 128) {
      throw new SidecarSpecError(
        `sidecar spec 'externalNetwork' must be Docker-safe if present, got ${JSON.stringify(obj.externalNetwork)}`,
        "spec-invalid",
      );
    }
  }

  // #179: Alias identity is an atomic pair.  A persisted alias without its
  // generation (or vice versa) would make detach/quarantine accounting
  // ambiguous, so reject it before anything reaches compose rendering.
  const hasNetworkAlias = obj.networkAlias !== undefined;
  const hasAliasGeneration = obj.aliasGeneration !== undefined;
  if (hasNetworkAlias !== hasAliasGeneration) {
    throw new SidecarSpecError(
      "sidecar spec 'networkAlias' and 'aliasGeneration' must be provided together",
      "spec-invalid",
    );
  }
  if (hasNetworkAlias) {
    if (typeof obj.networkAlias !== "string" || !isSafeYamlIdentifier(obj.networkAlias)) {
      throw new SidecarSpecError(
        `sidecar spec 'networkAlias' must be safe for YAML interpolation (lowercase alphanumeric start; lowercase alphanumeric/dash/underscore, max 63), got ${JSON.stringify(obj.networkAlias)}`,
        "spec-invalid",
      );
    }
    if (typeof obj.aliasGeneration !== "number" || !Number.isSafeInteger(obj.aliasGeneration) || obj.aliasGeneration < 1) {
      throw new SidecarSpecError(
        `sidecar spec 'aliasGeneration' must be a positive safe integer, got ${JSON.stringify(obj.aliasGeneration)}`,
        "spec-invalid",
      );
    }
  }

  if (obj.gatewayBinding !== undefined && typeof obj.gatewayBinding !== "boolean") {
    throw new SidecarSpecError(
      `sidecar spec 'gatewayBinding' must be boolean if present, got ${typeof obj.gatewayBinding}`,
      "spec-invalid",
    );
  }
  const hasGatewaySidecarImage = obj.gatewayBindingSidecarImage !== undefined;
  const hasGatewayImage = obj.gatewayBindingGatewayImage !== undefined;
  const hasGatewayComposeHash = obj.gatewayBindingComposeSha256 !== undefined;
  if (obj.gatewayBinding === true) {
    if (
      typeof obj.gatewayBindingSidecarImage !== "string"
      || typeof obj.gatewayBindingGatewayImage !== "string"
      || typeof obj.gatewayBindingComposeSha256 !== "string"
      || !isImmutableImageDigestReference(obj.gatewayBindingSidecarImage)
      || !isImmutableImageDigestReference(obj.gatewayBindingGatewayImage)
      || !/^[a-f0-9]{64}$/.test(obj.gatewayBindingComposeSha256)
    ) {
      throw new SidecarSpecError(
        "gateway-binding sidecar spec requires a validated immutable image pair and Compose digest",
        "spec-invalid",
      );
    }
  } else if (hasGatewaySidecarImage || hasGatewayImage || hasGatewayComposeHash) {
    throw new SidecarSpecError(
      "gateway-binding image and Compose digest fields require gatewayBinding=true",
      "spec-invalid",
    );
  }

  // updatedAt must be valid ISO 8601
  if (typeof obj.updatedAt !== "string" || isNaN(Date.parse(obj.updatedAt))) {
    throw new SidecarSpecError(
      `sidecar spec 'updatedAt' must be valid ISO 8601, got ${JSON.stringify(obj.updatedAt)}`,
      "spec-invalid",
    );
  }

  // Validate v2 required fields
  // identity fields: non-empty, valid identifier pattern
  if (typeof obj.managedInstanceId !== "string" || !obj.managedInstanceId || !/^[a-zA-Z0-9_-]+$/.test(obj.managedInstanceId)) {
    throw new SidecarSpecError(
      `sidecar spec 'managedInstanceId' must be a non-empty valid identifier, got ${JSON.stringify(obj.managedInstanceId)}`,
      "spec-invalid",
    );
  }
  if (typeof obj.bindingId !== "string" || !obj.bindingId || !/^[a-zA-Z0-9_-]+$/.test(obj.bindingId)) {
    throw new SidecarSpecError(
      `sidecar spec 'bindingId' must be a non-empty valid identifier, got ${JSON.stringify(obj.bindingId)}`,
      "spec-invalid",
    );
  }
  if (typeof obj.operationId !== "string" || !obj.operationId || !/^[a-zA-Z0-9_-]+$/.test(obj.operationId)) {
    throw new SidecarSpecError(
      `sidecar spec 'operationId' must be a non-empty valid identifier, got ${JSON.stringify(obj.operationId)}`,
      "spec-invalid",
    );
  }
  // versions: safe non-negative integers
  if (typeof obj.targetAttachmentVersion !== "number" || !Number.isSafeInteger(obj.targetAttachmentVersion) || obj.targetAttachmentVersion < 0) {
    throw new SidecarSpecError(
      `sidecar spec 'targetAttachmentVersion' must be a safe non-negative integer, got ${JSON.stringify(obj.targetAttachmentVersion)}`,
      "spec-invalid",
    );
  }
  if (typeof obj.targetConfigVersion !== "number" || !Number.isSafeInteger(obj.targetConfigVersion) || obj.targetConfigVersion < 0) {
    throw new SidecarSpecError(
      `sidecar spec 'targetConfigVersion' must be a safe non-negative integer, got ${JSON.stringify(obj.targetConfigVersion)}`,
      "spec-invalid",
    );
  }
  if (obj.desiredAttachmentState !== "attached" && obj.desiredAttachmentState !== "detached") {
    throw new SidecarSpecError(
      `sidecar spec 'desiredAttachmentState' must be "attached" or "detached", got ${JSON.stringify(obj.desiredAttachmentState)}`,
      "spec-invalid",
    );
  }

  // Reject unknown fields
  const allowed = new Set(["schemaVersion", "enabled", "serviceName", "envFile", "port", "externalNetwork", "networkAlias", "aliasGeneration", "gatewayBinding", "gatewayBindingSidecarImage", "gatewayBindingGatewayImage", "gatewayBindingComposeSha256", "composeProject", "managedInstanceId", "bindingId", "operationId", "targetAttachmentVersion", "targetConfigVersion", "desiredAttachmentState", "updatedAt"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new SidecarSpecError(
        `sidecar spec has unknown field '${key}', allowed: ${[...allowed].join(", ")}`,
        "spec-invalid",
      );
    }
  }
}

/**
 * Write the sidecar spec to the instance directory atomically.
 * Called during create/restore when weixin sidecar is provisioned.
 * Uses random unique temp file + rename for concurrency-safe atomicity.
 * Permissions set to 0600.
 */
export async function writeSidecarSpec(
  instDir: string,
  spec: SidecarSpec,
): Promise<void> {
  validateSpec(spec);
  await writeSidecarSpecRaw(instDir, spec);
}

/**
 * Write a sidecar spec WITHOUT validation.
 * Used for initial creation during spawn() where identity fields are not yet known.
 * The bridge handler will migrate/overwrite with full identity on first attach/detach.
 */
export async function writeSidecarSpecRaw(
  instDir: string,
  spec: SidecarSpec,
): Promise<void> {
  const specPath = join(instDir, SPEC_FILENAME);
  // Random unique temp file for concurrency safety
  const tmpPath = join(instDir, `${SPEC_FILENAME}.${randomBytes(8).toString("hex")}.tmp`);

  try {
    // Exclusive create — fails if file exists (race protection)
    const fd = await open(tmpPath, "wx", 0o600);
    try {
      await fd.writeFile(JSON.stringify(spec, null, 2) + "\n");
    } finally {
      await fd.close();
    }
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, specPath);
  } catch (error) {
    // Clean up temp file on any failure
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
 * #171 Phase 2A-2: Migrate a v1 spec file to v2 using ClawBay request identity.
 * This is the ONLY valid migration path — identity must come from the caller,
 * not from empty defaults.
 *
 * Throws if spec is corrupted or missing.
 * Returns true if a migration was performed, false if spec was already v2.
 */
export async function migrateSidecarSpec(
  instDir: string,
  identity: {
    managedInstanceId: string;
    bindingId: string;
    operationId: string;
    targetAttachmentVersion: number;
    targetConfigVersion: number;
    desiredAttachmentState: "attached" | "detached";
  },
): Promise<boolean> {
  const specPath = join(instDir, SPEC_FILENAME);
  const file = Bun.file(specPath);
  if (!(await file.exists())) {
    return false; // No spec to migrate
  }
  const text = await file.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SidecarSpecError(
      "sidecar-spec.json contains invalid JSON",
      "spec-corrupted",
    );
  }
  if (typeof data !== "object" || data === null) {
    throw new SidecarSpecError("sidecar spec is not an object", "spec-invalid");
  }
  const obj = data as Record<string, unknown>;
  if (obj.schemaVersion === SCHEMA_VERSION) {
    return false; // Already v2
  }
  if (obj.schemaVersion !== 1) {
    throw new SidecarSpecError(
      `Cannot migrate spec: unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}`,
      "spec-invalid",
    );
  }
  // Write v2 spec with ClawBay-provided identity
  const migrated: SidecarSpec = {
    schemaVersion: SCHEMA_VERSION,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : false,
    serviceName: "weixin-sidecar",
    envFile: ".env.weixin",
    port: 8787,
    composeProject: typeof obj.composeProject === "string" ? obj.composeProject : "",
    managedInstanceId: identity.managedInstanceId,
    bindingId: identity.bindingId,
    operationId: identity.operationId,
    targetAttachmentVersion: identity.targetAttachmentVersion,
    targetConfigVersion: identity.targetConfigVersion,
    desiredAttachmentState: identity.desiredAttachmentState,
    updatedAt: new Date().toISOString(),
  };
  await writeSidecarSpec(instDir, migrated);
  return true;
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

/**
 * #171: Backfill sidecar spec for pre-#171 instances.
 *
 * Pre-#171 instances may have a compose file with a weixin-sidecar service
 * but no `sidecar-spec.json`. This function provides EXPLICIT backfill —
 * the caller must provide authoritative spec data (from ClawBay control-plane
 * SRI configuration), not guessed from .env.weixin existence.
 *
 * Fail-closed: if an existing spec is corrupted, throws (does not overwrite).
 * Returns true if a spec was written, false if one already exists.
 */
export async function backfillSidecarSpec(
  instDir: string,
  spec: SidecarSpec,
): Promise<boolean> {
  // Check if spec already exists — distinguish ENOENT from corruption
  try {
    const existing = await readSidecarSpec(instDir);
    if (existing !== null) {
      return false; // Already has a valid spec
    }
  } catch (error) {
    // Corrupted or invalid spec — fail-closed, do NOT overwrite
    throw error;
  }

  // No spec exists — write the authoritative one
  await writeSidecarSpec(instDir, spec);
  return true;
}
