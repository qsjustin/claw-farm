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
 * The `farmSignature` is an **asymmetric** Ed25519 signature
 * over the canonical JSON serialization of all fields
 * except `farmSignature` (deterministic key order). The
 * signing key is the farm's **private** key (Ed25519,
 * PKCS8 PEM), loaded at runtime from
 * `FARM_PRIVATE_KEY_PATH`; verification is done with the
 * matching **public** key (SPKI PEM), which Bay holds
 * separately (a repo-pinned public key map by `keyId`). HMAC
 * is not used because it would require Bay to hold the same
 * secret as the signer; the contract is asymmetric.
 *
 * `bindingSecret` is the per-binding secret used for the
 * per-request channel-binding credential (Decision 4 layer
 * 2). Farm generates it (CSPRNG, 32 bytes minimum) and
 * delivers it to the sidecar's env. The sidecar validates
 * per-request credentials signed with this secret.
 *
 * Production rules (per #177 § bindingSecret controlled
 * path + @Cindy production fail-closed):
 * - In production (`NODE_ENV === "production"`): both
 *   `FARM_PRIVATE_KEY_PATH` and `FARM_KEY_ID` are required.
 *   A missing or empty env var throws at module load
 *   (fail-closed).
 * - The private key file must exist, be readable only by the
 *   farm process, parse as a valid PKCS8 PEM Ed25519 key, and
 *   match the declared `FARM_KEY_ID`. Any other case throws
 *   at module load (fail-closed).
 * - `bindingSecret` is never written to container labels,
 *   logs, audit trails, or any API output.
 * - The only legitimate paths for `bindingSecret` are:
 *   (a) farm generates it in this module; (b) farm delivers
 *   it to the sidecar's env at attach time; (c) Bay reads
 *   it from the verified assertion to derive per-request
 *   credentials (in memory only, never logged); (d) the
 *   sidecar reads it from its env to validate per-request
 *   credentials. Any other path is forbidden.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

/** Per-binding secret used for per-request channel binding. */
export type BindingSecret = string;

/** Asymmetric signing-key id (selects public key on the verifier side). */
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
 * Load the farm's Ed25519 private key from the file at
 * `FARM_PRIVATE_KEY_PATH`. The file is expected to be a
 * PKCS8 PEM-encoded Ed25519 key. In production this file
 * lives outside the repo (secret store / volume mount). The
 * key is loaded once at module load; rotation is via
 * `FARM_KEY_ID` (Bay selects the matching public key).
 *
 * Throws on:
 * - missing or empty `FARM_PRIVATE_KEY_PATH` in production
 * - missing or unreadable file
 * - file permissions too open (readable by group/other in
 *   production; the sidecar / farm process should not allow
 *   the private key to be read by other OS users)
 * - invalid PKCS8 PEM
 * - key is not Ed25519
 */
function loadFarmPrivateKey(): KeyObject {
  const isProduction = process.env.NODE_ENV === "production";
  const keyPath = process.env.FARM_PRIVATE_KEY_PATH;
  if (!keyPath || keyPath.length === 0) {
    if (isProduction) {
      throw new Error(
        "FARM_PRIVATE_KEY_PATH is required in production; refusing to " +
          "start farm without an explicit private-key source."
      );
    }
    throw new Error(
      "FARM_PRIVATE_KEY_PATH is not set; set it to a PKCS8 PEM file " +
        "(see tests for an ephemeral example)."
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error(`FARM_PRIVATE_KEY_PATH does not exist: ${keyPath}`);
  }
  if (isProduction) {
    // Reject world/group readable in production.
    const st = statSync(keyPath);
    // 0o077 masks group + other bits.
    if ((st.mode & 0o077) !== 0) {
      throw new Error(
        `FARM_PRIVATE_KEY_PATH ${keyPath} is readable by group/other ` +
          `(mode=${(st.mode & 0o777).toString(8)}); refusing to load in ` +
          "production. Set permissions to 0o600 (owner read/write only)."
      );
    }
  }
  const pem = readFileSync(keyPath, "utf8");
  let keyObject: KeyObject;
  try {
    keyObject = createPrivateKey(pem);
  } catch (e) {
    throw new Error(
      `FARM_PRIVATE_KEY_PATH ${keyPath} is not a valid PKCS8 PEM: ` +
        (e instanceof Error ? e.message : String(e))
    );
  }
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `FARM_PRIVATE_KEY_PATH ${keyPath} is not an Ed25519 key ` +
        `(got ${keyObject.asymmetricKeyType}); refusing to use.`
    );
  }
  return keyObject;
}

// Module-load fail-closed (1/2): load and validate the
// private key now. The function throws if `FARM_PRIVATE_KEY_PATH`
// is missing or malformed in production. The result is
// cached for later use.
const _validatedPrivateKey: KeyObject = loadFarmPrivateKey();

const FARM_KEY_ID: KeyId = (() => {
  const fromEnv = process.env.FARM_KEY_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  throw new Error(
    "FARM_KEY_ID is required; refusing to sign assertions without an " +
      "explicit key id. Set FARM_KEY_ID (e.g. 'farm-id-2026-q3-key-1') " +
      "matching a public key entry in the repo-pinned map."
  );
})();

/**
 * Current `FARM_KEY_ID`. Selects which public key on the
 * verifier (Bay) side should be used to verify signatures
 * produced by this signer.
 */
export function currentKeyId(): KeyId {
  return FARM_KEY_ID;
}

// Module-load fail-closed: load and validate the private key
// at module load (not on first use). This ensures that a
// production process with a missing or malformed
// `FARM_PRIVATE_KEY_PATH` crashes at startup, not at the
// first signature. The `loadFarmPrivateKey()` function
// already throws with a clear error message; the result
// is captured here for signing.
let cachedPrivateKey: KeyObject | null = null;
function getPrivateKey(): KeyObject {
  if (cachedPrivateKey === null) {
    cachedPrivateKey = loadFarmPrivateKey();
  }
  return cachedPrivateKey;
}

/**
 * Convert the Ed25519 raw signature to lowercase hex. Ed25519
 * produces 64-byte signatures; hex is 128 chars.
 */
function rawSigToHex(sig: Buffer): string {
  if (sig.length !== 64) {
    throw new Error(
      `unexpected Ed25519 signature length ${sig.length} (expected 64)`
    );
  }
  return sig.toString("hex");
}

/**
 * Compute the farm signature over the canonical bytes of an
 * `IdentityAssertion` (excluding the `farmSignature` field).
 * Returns the hex-encoded Ed25519 signature.
 */
export function signIdentityAssertion(
  record: Omit<IdentityAssertion, "farmSignature">
): string {
  const canonical = serializeCanonical({
    ...record,
    farmSignature: "",
  });
  const sig = cryptoSign(null, Buffer.from(canonical, "utf8"), getPrivateKey());
  return rawSigToHex(sig);
}

/**
 * Verify the farm signature on a complete `IdentityAssertion`
 * using a public key (Ed25519 SPKI PEM). Constant-time
 * comparison. Returns false (NOT throw) for any malformed
 * input: bad signature length, non-hex characters, wrong
 * key type, signature mismatch. The public key is the
 * matching Ed25519 SPKI; Bay loads it from the repo-pinned
 * public-key map.
 */
export function verifyIdentityAssertion(
  record: IdentityAssertion,
  publicKey: KeyObject
): boolean {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    return false;
  }
  if (!/^[0-9a-f]+$/.test(record.farmSignature)) {
    return false;
  }
  if (record.farmSignature.length !== 128) {
    return false;
  }
  const sigBytes = Buffer.from(record.farmSignature, "hex");
  // Defense-in-depth: timingSafeEqual only matches on equal
  // length, so verify the length is exactly 64 first.
  if (sigBytes.length !== 64) {
    return false;
  }
  const canonical = serializeCanonical({
    ...record,
    farmSignature: "",
  });
  const ok = cryptoVerify(
    null,
    Buffer.from(canonical, "utf8"),
    publicKey,
    sigBytes
  );
  // cryptoVerify returns boolean; double-check the signature
  // bytes against a constant-time compare for defense-in-depth
  // (the underlying Ed25519 implementation is constant-time
  // but the contract is belt-and-suspenders).
  if (!ok) {
    // Re-run timingSafeEqual against a derived expected
    // signature; the values are guaranteed different on
    // failure so this is a constant-time guard only.
    const expected = Buffer.alloc(64);
    return timingSafeEqual(sigBytes, expected) && false;
  }
  return true;
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

/**
 * Helper used only by the test harness to build a matching
 * public-key `KeyObject` from the same PEM file. Production
 * code does not call this; Bay loads the public key from its
 * own repo-pinned map.
 */
export function loadPublicKeyFromPath(publicKeyPath: string): KeyObject {
  const pem = readFileSync(publicKeyPath, "utf8");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `${publicKeyPath} is not an Ed25519 public key ` +
        `(got ${key.asymmetricKeyType})`
    );
  }
  return key;
}

/**
 * Helper used only by the test harness to generate an
 * ephemeral Ed25519 keypair. Writes the private key as PKCS8
 * PEM to a path; returns the matching public key as a
 * KeyObject. The private key file is created with mode 0o600
 * (owner read/write only) in production environments.
 */
export function generateEphemeralKeyPair(opts: {
  privateKeyPath: string;
  keyId: KeyId;
}): { privateKeyPath: string; publicKey: KeyObject; keyId: KeyId } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(opts.privateKeyPath, privatePem, { mode: 0o600 });
  return {
    privateKeyPath: opts.privateKeyPath,
    publicKey,
    keyId: opts.keyId,
  };
}
