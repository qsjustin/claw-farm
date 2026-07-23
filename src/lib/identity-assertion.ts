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
  generateKeyPairSync,
  sign as cryptoSign,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

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
    const privateKey = createPublicKey(privateKeyPem);
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
 * Export the public key map JSON for Bay's FARM_VERIFICATION_KEYS_PATH.
 * Format: { "<keyId>": "<publicKeyPem>" }
 */
export function buildPublicKeyMapJson(keys: FarmKeyPair[]): string {
  const map: Record<string, string> = {};
  for (const kp of keys) {
    map[kp.keyId] = kp.publicKeyPem;
  }
  return JSON.stringify(map, null, 2) + "\n";
}

// ─── Canonical bytes + signing ───────────────────────────────────────────────

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
export function signIdentityAssertion(input: {
  sri: string;
  sidecarCode: string;
  composeProject: string;
  networkAlias: string;
  port: number;
  containerId: string | null;
  generation: number;
  validitySeconds: number;  // assertion validity window
  keyPair: FarmKeyPair;
  now?: Date;
}): SignedAssertionResult {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.validitySeconds * 1000);

  // Generate bindingSecret: 32-byte CSPRNG, hex-encoded (64 chars)
  const bindingSecret = randomBytes(32).toString("hex");

  const fields = {
    sri: input.sri,
    sidecarCode: input.sidecarCode,
    composeProject: input.composeProject,
    networkAlias: input.networkAlias,
    port: input.port,
    containerId: input.containerId,
    generation: input.generation,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    keyId: input.keyPair.keyId,
  };

  const canonical = buildCanonicalBytes(fields);

  // Ed25519 sign — uses crypto.sign() directly (not createSign)
  const signature = cryptoSign(null, canonical, input.keyPair.privateKeyPem);
  const farmSignature = signature.toString("base64");

  return {
    assertion: {
      ...fields,
      farmSignature,
      bindingSecret,
    },
    publicKeyPem: input.keyPair.publicKeyPem,
  };
}
