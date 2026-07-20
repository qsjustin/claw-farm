/**
 * #171B Round 36 + #179 (#171-A implementation): per-instance sidecar
 * endpoint identity — `IdentityAssertion` builder + signer.
 *
 * Per the approved #177 architecture-decision contract (SHA
 * `23e7cb9`), farm is the only writer of the structured
 * `IdentityAssertion` record. The record is:
 *
 *   type IdentityAssertion = {
 *     sri: string;
 *     sidecarCode: string;
 *     composeProject: string;
 *     networkAlias: string;
 *     port: number;
 *     containerId: string;
 *     generation: number;
 *     issuedAt: string;
 *     expiresAt: string;
 *     keyId: string;
 *     bindingSecret: string;
 *     farmSignature: string;
 *   };
 *
 * The `farmSignature` is computed by farm over the canonical
 * JSON serialization of all fields except `farmSignature`
 * (deterministic key order) using the farm's signing key
 * identified by `keyId`. Bay holds the corresponding
 * verification key.
 *
 * `bindingSecret` is the per-binding secret used for the
 * per-request channel-binding credential (Decision 4 layer
 * 2). Farm generates it (CSPRNG, 32 bytes minimum) and
 * delivers it to the sidecar's env. The sidecar validates
 * per-request credentials signed with this secret.
 *
 * This module contains:
 * - `generateBindingSecret()`: CSPRNG 32-byte secret.
 * - `currentKeyId()` / `signer()`: in-test, the signing key is
 *   a process-local Ed25519 / HMAC-SHA-256 key. A
 *   repo-pinned public key is the production goal; for
 *   #179 implementation the in-test key is sufficient to
 *   prove the contract. The same signing primitive is used.
 * - `buildIdentityAssertion(...)`: produce a structured
 *   record with deterministic JSON serialization.
 * - `serializeCanonical(...)`: deterministic key order.
 * - `signIdentityAssertion(record)`: produce farmSignature.
 * - `verifyIdentityAssertion(record)`: for tests and for the
 *   diagnostic path (Bay calls verify before persisting).
 *
 * Exposure rules (per #177 § bindingSecret controlled path):
 * - `bindingSecret` is never written to container labels,
 *   logs, audit trails, or any API output.
 * - It is never returned to a client.
 * - It is never accepted as client input.
 * - It is encrypted at rest in any persisted form (Bay's
 *   storage; not farm's concern here since farm produces
 *   it once and delivers it).
 * - The only legitimate paths for `bindingSecret` are:
 *   (a) farm generates it in this module; (b) farm delivers
 *   it to the sidecar's env at attach time; (c) Bay reads
 *   it from the verified assertion to derive per-request
 *   credentials (in memory only, never logged); (d) the
 *   sidecar reads it from its env to validate per-request
 *   credentials. Any other path is forbidden.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Per-binding secret used for per-request channel binding. */
export type BindingSecret = string;

/** HMAC-SHA-256 signing key id. */
export type KeyId = string;

export type IdentityAssertion = {
  sri: string;
  sidecarCode: string;
  composeProject: string;
  networkAlias: string;
  port: number;
  containerId: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  keyId: KeyId;
  bindingSecret: BindingSecret;
  farmSignature: string;
};

/** Canonical key order for deterministic JSON serialization. */
const CANONICAL_KEY_ORDER: ReadonlyArray<keyof IdentityAssertion> = [
  "sri",
  "sidecarCode",
  "composeProject",
  "networkAlias",
  "port",
  "containerId",
  "generation",
  "issuedAt",
  "expiresAt",
  "keyId",
  "bindingSecret",
  // "farmSignature" is intentionally excluded from the signed
  // payload (it is the signature itself).
] as const;

/**
 * Serialize an `IdentityAssertion` to a deterministic JSON
 * byte string for signing / verification. Keys are in the
 * canonical order; values are JSON-stringified. No whitespace
 * variation; no extra fields.
 */
export function serializeCanonical(record: IdentityAssertion): string {
  const parts: string[] = [];
  for (const key of CANONICAL_KEY_ORDER) {
    const value = record[key];
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Generate a per-binding secret using a CSPRNG. Returns a
 * hex-encoded string of `byteLength * 2` characters
 * (default 64 chars = 32 bytes).
 */
export function generateBindingSecret(byteLength = 32): BindingSecret {
  if (byteLength < 32) {
    throw new Error(
      `bindingSecret byteLength must be >= 32 (got ${byteLength})`
    );
  }
  return randomBytes(byteLength).toString("hex");
}

/**
 * Process-local signing key (test/dev). For production, a
 * repo-pinned public key is the goal (see #177 § Farm
 * verification key distribution). This module exposes the
 * same primitive so the contract is testable today; switching
 * to a pinned-key model in #177-A implementation is a
 * configuration change, not a contract change.
 */
/**
 * The farm signing key. In production, this MUST be supplied
 * from a controlled source (a private-key provider, a secret
 * store) via the `FARM_SIGNING_KEY_HEX` env var. There is no
 * production fallback: if the env var is missing or malformed
 * in production, the farm signing primitive throws at module
 * load time (fail-closed). The fallback below is gated on
 * `NODE_ENV !== "production"` so a developer running the
 * farm in a dev environment does not have to set up a secret
 * store; tests set the env var explicitly via the `FARM_*`
 * env vars in the test harness.
 */
const FARM_SIGNING_KEY_HEX = (() => {
  const fromEnv = process.env.FARM_SIGNING_KEY_HEX;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FARM_SIGNING_KEY_HEX is required in production; refusing to " +
        "start farm with an ephemeral / default signing key. " +
        "Configure the private key in the secret store and set " +
        "FARM_SIGNING_KEY_HEX (and FARM_KEY_ID) before starting the " +
        "farm process."
    );
  }
  // Dev / test fallback: 32 bytes; deterministic so verify
  // works across processes in a test harness.
  return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
})();

const FARM_KEY_ID: KeyId = (() => {
  const fromEnv = process.env.FARM_KEY_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "FARM_KEY_ID is required in production; refusing to start " +
        "farm with the default test key id. Set FARM_KEY_ID to " +
        "the id of the repo-pinned farm signing key."
    );
  }
  return "farm-id-test-key-1";
})();

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey === null) {
    cachedKey = Buffer.from(FARM_SIGNING_KEY_HEX, "hex");
  }
  return cachedKey;
}

export function currentKeyId(): KeyId {
  return FARM_KEY_ID;
}

/**
 * Compute the farm signature over the canonical bytes of an
 * `IdentityAssertion` (excluding the `farmSignature` field).
 * Returns the hex-encoded HMAC-SHA-256.
 */
export function signIdentityAssertion(
  record: Omit<IdentityAssertion, "farmSignature">
): string {
  const canonical = serializeCanonical({
    ...record,
    farmSignature: "",
  });
  const hmac = createHmac("sha256", getKey());
  hmac.update(canonical);
  return hmac.digest("hex");
}

/**
 * Verify the farm signature on a complete `IdentityAssertion`.
 * Constant-time comparison.
 */
export function verifyIdentityAssertion(record: IdentityAssertion): boolean {
  const expected = signIdentityAssertion({
    sri: record.sri,
    sidecarCode: record.sidecarCode,
    composeProject: record.composeProject,
    networkAlias: record.networkAlias,
    port: record.port,
    containerId: record.containerId,
    generation: record.generation,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    keyId: record.keyId,
    bindingSecret: record.bindingSecret,
  });
  if (expected.length !== record.farmSignature.length) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(record.farmSignature, "hex")
  );
}

/**
 * Build and sign a complete `IdentityAssertion` from its
 * constituent fields. The `bindingSecret` is supplied by
 * the caller (typically `generateBindingSecret()`); the
 * `farmSignature` is computed by this function. The caller
 * is responsible for delivering `bindingSecret` to the
 * sidecar's env separately; this function does not write
 * to the sidecar's env.
 */
export function buildIdentityAssertion(input: {
  sri: string;
  sidecarCode: string;
  composeProject: string;
  networkAlias: string;
  port: number;
  containerId: string;
  generation: number;
  issuedAt: Date;
  expiresAt: Date;
  bindingSecret: BindingSecret;
}): IdentityAssertion {
  const keyId = currentKeyId();
  const issuedAtIso = input.issuedAt.toISOString();
  const expiresAtIso = input.expiresAt.toISOString();
  const record: Omit<IdentityAssertion, "farmSignature"> = {
    sri: input.sri,
    sidecarCode: input.sidecarCode,
    composeProject: input.composeProject,
    networkAlias: input.networkAlias,
    port: input.port,
    containerId: input.containerId,
    generation: input.generation,
    issuedAt: issuedAtIso,
    expiresAt: expiresAtIso,
    keyId,
    bindingSecret: input.bindingSecret,
  };
  const farmSignature = signIdentityAssertion(record);
  return { ...record, farmSignature };
}
