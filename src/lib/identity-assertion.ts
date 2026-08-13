/**
 * Farm-side IdentityAssertion signing and alias management.
 *
 * Per the approved #177 architecture-decision contract:
 * - Farm is the authoritative signer of IdentityAssertions
 * - Farm computes the deterministic networkAlias for (sri, generation)
 * - Farm generates the bindingSecret (32-byte CSPRNG, hex-encoded)
 * - Farm signs the assertion with its Ed25519 private key
 * - Bay verifies the assertion with the pinned farm public key
 *
 * Alias lifecycle: 2-phase release
 * - Phase 1 (detach): alias marked `released`, compose down
 * - Phase 2 (deleted): after all assertions expired + DNS retention
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !process.env.FARM_PRIVATE_KEY_PATH) {
  throw new Error("FARM_PRIVATE_KEY_PATH is required in production");
}
if (isProduction && !process.env.FARM_KEY_ID) {
  throw new Error("FARM_KEY_ID is required in production");
}


export interface IdentityAssertionFields {
  sri: string;                    // service runtime instance ID
  sidecarCode: string;            // e.g. "weixin-auth-sidecar"
  composeProject: string;         // docker compose project name
  networkAlias: string;           // deterministic per-(sri, generation)
  port: number;                   // sidecar HTTP port
  containerId: string | null;     // docker container ID (may be null at signing time)
  generation: number;             // monotonically increasing per (sri, sidecarCode)
  issuedAt: string;               // ISO 8601
  expiresAt: string;              // ISO 8601
  keyId: string;                  // farm signing key identifier
  farmSignature: string;          // Ed25519 signature over canonical bytes (base64)
  bindingSecret: string;          // 32-byte CSPRNG hex (64 chars) — ONLY in-memory, never persisted by farm
}

export interface SignedAssertionResult {
  assertion: IdentityAssertionFields;
  /** Public key PEM for Bay to pin (write to FARM_VERIFICATION_KEYS_PATH). */
  publicKeyPem: string;
}

// ─── Alias derivation ───────────────────────────────────────────────────────

/**
 * Deterministic alias: "clawbay-sidecar-" + sha256(sri).hex()[:12]
 * 48 bits of hash space; collision probability ~N^2/2^49 (negligible).
 */
export function deriveNetworkAlias(sri: string): string {
  const { createHash } = require("node:crypto");
  const hash = createHash("sha256").update(sri).digest("hex").slice(0, 12);
  return `clawbay-sidecar-${hash}`;
}

// ─── Key management ─────────────────────────────────────────────────────────

export interface FarmKeyPair {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * Generate a new Ed25519 keypair for farm signing.
 * The keyId is derived from the public key fingerprint.
 */
export function generateFarmKeyPair(): FarmKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  // keyId = first 8 hex chars of SHA-256(publicKeyPem)
  const { createHash } = require("node:crypto");
  const keyId = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 8);

  return { keyId, privateKey, publicKey, publicKeyPem, privateKeyPem };
}

/**
 * Load farm keypair from files. If files don't exist, generate and save.
 * @param keyDir directory containing farm-key-id, farm-private.pem, farm-public.pem
 */
export function loadOrGenerateFarmKeys(keyDir: string): FarmKeyPair {
  const idPath = join(keyDir, "farm-key-id");
  const privPath = join(keyDir, "farm-private.pem");
  const pubPath = join(keyDir, "farm-public.pem");

  try {
    const keyId = readFileSync(idPath, "utf8").trim();
    const privateKeyPem = readFileSync(privPath, "utf8");
    const publicKeyPem = readFileSync(pubPath, "utf8");
    const privateKey = createPrivateKey(privateKeyPem);
    const publicKey = createPublicKey(publicKeyPem);
    return { keyId, privateKey, publicKey, publicKeyPem, privateKeyPem };
  } catch {
    // Files missing or corrupt — generate new keypair
    const { mkdirSync } = require("node:fs");
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    const kp = generateFarmKeyPair();
    writeFileSync(idPath, kp.keyId + "\n", { mode: 0o600 });
    writeFileSync(privPath, kp.privateKeyPem, { mode: 0o600 });
    writeFileSync(pubPath, kp.publicKeyPem, { mode: 0o644 });
    return kp;
  }
}

/**
 * Load the explicitly configured Farm signing identity.  Production already
 * requires FARM_PRIVATE_KEY_PATH and FARM_KEY_ID at module load; the bridge
 * must actually use those values rather than silently generating a second
 * key under HOME.  Returning null preserves the legacy development fallback
 * when neither setting is present.
 */
export function loadConfiguredFarmKeyPair(): FarmKeyPair | null {
  const privatePath = process.env.FARM_PRIVATE_KEY_PATH?.trim();
  const keyId = process.env.FARM_KEY_ID?.trim();
  if (!privatePath && !keyId) return null;
  if (!privatePath || !keyId) {
    throw new Error("FARM_PRIVATE_KEY_PATH and FARM_KEY_ID must be configured together");
  }

  const privateKeyPem = readFileSync(privatePath, "utf8");
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("configured farm private key is not Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("configured farm public key is not Ed25519");
  }
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  return { keyId, privateKey, publicKey, publicKeyPem, privateKeyPem };
}

/**
 * Export the public key map JSON for Bay's FARM_VERIFICATION_KEYS_PATH.
 * Format: { "<keyId>": "<publicKeyPem>" }
 */
export function loadPublicKeyFromPath(publicKeyPath: string): KeyObject {
  const key = createPublicKey(readFileSync(publicKeyPath, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("public key is not Ed25519");
  return key;
}

export function generateBindingSecret(byteLength = 32): string {
  if (byteLength < 32) throw new Error(`bindingSecret byteLength must be >= 32 (got ${byteLength})`);
  return randomBytes(byteLength).toString("hex");
}

export function serializeCanonical(record: IdentityAssertion | Record<string, unknown>): string {
  const ordered = ["sri", "sidecarCode", "composeProject", "networkAlias", "port", "containerId", "generation", "issuedAt", "expiresAt", "keyId", "bindingSecret"] as const;
  return `{${ordered.map((key) => `${JSON.stringify(key)}:${JSON.stringify((record as Record<string, unknown>)[key] instanceof Date ? ((record as Record<string, unknown>)[key] as Date).toISOString() : (record as Record<string, unknown>)[key])}`).join(",")}}`;
}

export interface IdentityAssertion {
  sri: string;
  sidecarCode: string;
  composeProject: string;
  networkAlias: string;
  port: number;
  containerId: string;
  generation: number;
  issuedAt: string;
  expiresAt: string;
  keyId: string;
  bindingSecret: string;
  farmSignature: string;
}
export type { IdentityAssertionFields as IdentityAssertionFieldsCompat };

export function verifyIdentityAssertion(record: IdentityAssertion | Record<string, unknown>, publicKey: KeyObject): boolean {
  try {
    if (publicKey.asymmetricKeyType !== "ed25519" || typeof record.farmSignature !== "string" || !/^[0-9a-f]{128}$/.test(record.farmSignature)) return false;
    const { farmSignature, ...unsigned } = record;
    return cryptoVerify(null, Buffer.from(serializeCanonical(unsigned), "utf8"), publicKey, Buffer.from(farmSignature, "hex"));
  } catch { return false; }
}

export function buildIdentityAssertion(input: IdentityAssertion | {
  sri: string; sidecarCode: string; composeProject: string; networkAlias: string; port: number;
  containerId: string; generation: number; issuedAt: Date; expiresAt: Date; bindingSecret: string;
}): IdentityAssertion {
  const privatePath = process.env.FARM_PRIVATE_KEY_PATH;
  const keyId = process.env.FARM_KEY_ID;
  if (!privatePath || !keyId) throw new Error("FARM_PRIVATE_KEY_PATH and FARM_KEY_ID are required");
  const privateKey = createPrivateKey(readFileSync(privatePath, "utf8"));
  const toIso = (v: string | Date) => v instanceof Date ? v.toISOString() : v;
  const record: Omit<IdentityAssertion, "farmSignature"> = { sri: input.sri, sidecarCode: input.sidecarCode, composeProject: input.composeProject, networkAlias: input.networkAlias, port: input.port, containerId: input.containerId, generation: input.generation, issuedAt: toIso(input.issuedAt), expiresAt: toIso(input.expiresAt), keyId, bindingSecret: input.bindingSecret };
  return { ...record, farmSignature: cryptoSign(null, Buffer.from(serializeCanonical(record), "utf8"), privateKey).toString("hex") };
}


export function buildPublicKeyMapJson(keys: FarmKeyPair[]): string {
  return JSON.stringify(Object.fromEntries(keys.map((kp) => [kp.keyId, kp.publicKeyPem])), null, 2) + "\n";
}


/**
 * Build canonical bytes for signing:
 * length-prefixed fields in fixed order.
 * Each field: 4-byte big-endian length + UTF-8 bytes.
 */
function buildCanonicalBytes(fields: Record<string, string | number | null>): Buffer {
  const entries = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b));
  const parts: Buffer[] = [];
  for (const [key, value] of entries) {
    const str = value === null ? "" : String(value);
    const keyBuf = Buffer.from(key, "utf8");
    const valBuf = Buffer.from(str, "utf8");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(keyBuf.length, 0);
    parts.push(lenBuf, keyBuf);
    const vlenBuf = Buffer.alloc(4);
    vlenBuf.writeUInt32BE(valBuf.length, 0);
    parts.push(vlenBuf, valBuf);
  }
  return Buffer.concat(parts);
}

/**
 * Sign an IdentityAssertion. Returns the assertion fields + bindingSecret.
 * The bindingSecret is generated fresh (32-byte CSPRNG, hex-encoded).
 */
export function currentKeyId(): string {
  const keyId = process.env.FARM_KEY_ID;
  if (!keyId) throw new Error("FARM_KEY_ID is required");
  return keyId;
}

export function signIdentityAssertion(input: Record<string, unknown>): string | SignedAssertionResult {
  if ("keyPair" in input) {
    const typed = input as Parameters<typeof signIdentityAssertionResult>[0];
    return signIdentityAssertionResult(typed);
  }
  const privatePath = process.env.FARM_PRIVATE_KEY_PATH;
  if (!privatePath) throw new Error("FARM_PRIVATE_KEY_PATH is required");
  const record = input;
  const canonical = serializeCanonical(record);
  return cryptoSign(null, Buffer.from(canonical, "utf8"), createPrivateKey(readFileSync(privatePath, "utf8"))).toString("hex");
}

function signIdentityAssertionResult(input: {
  sri: string; sidecarCode: string; composeProject: string; networkAlias: string; port: number;
  containerId: string | null; generation: number; validitySeconds: number; keyPair: FarmKeyPair; now?: Date;
  bindingSecret?: string;
}): SignedAssertionResult {
  const now = input.now ?? new Date();
  const bindingSecret = input.bindingSecret ?? randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/i.test(bindingSecret)) {
    throw new Error("bindingSecret must be a 64-character hex string");
  }
  const fields = { sri: input.sri, sidecarCode: input.sidecarCode, composeProject: input.composeProject,
    networkAlias: input.networkAlias, port: input.port, containerId: input.containerId ?? "",
    generation: input.generation, issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.validitySeconds * 1000).toISOString(),
    keyId: input.keyPair.keyId, bindingSecret };
  return { assertion: { ...fields, farmSignature: cryptoSign(null, Buffer.from(serializeCanonical(fields), "utf8"), input.keyPair.privateKey).toString("hex") }, publicKeyPem: input.keyPair.publicKeyPem };
}
