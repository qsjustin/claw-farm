/**
 * Farm-side IdentityAssertion signing and deployment key handling.
 *
 * The canonical payload exactly matches the approved #177 contract and the
 * Bay verifier: deterministic JSON key order over every field preceding
 * farmSignature, including bindingSecret. Ed25519 signatures are lowercase
 * 128-character hex strings.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface IdentityAssertionFields {
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

export interface SignedAssertionResult {
  assertion: IdentityAssertionFields;
  /** Public key PEM for Bay's pinned FARM_VERIFICATION_KEYS_PATH map. */
  publicKeyPem: string;
}

export const IDENTITY_ASSERTION_CANONICAL_KEY_ORDER: ReadonlyArray<keyof IdentityAssertionFields> = [
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
] as const;

export function serializeIdentityAssertionCanonical(record: IdentityAssertionFields): string {
  const parts: string[] = [];
  for (const key of IDENTITY_ASSERTION_CANONICAL_KEY_ORDER) {
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(record[key])}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Deterministic base candidate. The durable authoritative registry resolves a
 * collision or generation overlap before the alias is used by compose.
 */
export function deriveNetworkAlias(sri: string): string {
  const hash = createHash("sha256").update(sri).digest("hex").slice(0, 12);
  return `clawbay-sidecar-${hash}`;
}

export interface FarmKeyPair {
  keyId: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  privateKeyPem: string;
}

function fingerprintKeyId(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 8);
}

function validateKeyId(keyId: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("farm-key-id must be a non-empty safe identifier (max 64 chars)");
  }
}

function validatePrivateKeyPermissions(path: string): void {
  if (process.env.NODE_ENV !== "production") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `farm private key is readable by group/other (mode=${mode.toString(8)}); ` +
      "production requires owner-only permissions (0600)",
    );
  }
}

function parseAndValidateKeyPair(input: {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  privateKeyPath?: string;
}): FarmKeyPair {
  validateKeyId(input.keyId);
  if (input.privateKeyPath) validatePrivateKeyPermissions(input.privateKeyPath);

  let privateKey: KeyObject;
  let publicKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
  } catch (error) {
    throw new Error(`farm private key is not valid PKCS8 PEM: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    publicKey = createPublicKey(input.publicKeyPem);
  } catch (error) {
    throw new Error(`farm public key is not valid SPKI PEM: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`farm private key must be Ed25519 (got ${privateKey.asymmetricKeyType})`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`farm public key must be Ed25519 (got ${publicKey.asymmetricKeyType})`);
  }

  const derivedPublicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;
  const normalizedPublicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  if (derivedPublicPem !== normalizedPublicPem) {
    throw new Error("farm private/public key files do not form a matching Ed25519 pair");
  }

  return {
    keyId: input.keyId,
    privateKey,
    publicKey,
    privateKeyPem: input.privateKeyPem,
    publicKeyPem: normalizedPublicPem,
  };
}

export function generateFarmKeyPair(): FarmKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return {
    keyId: fingerprintKeyId(publicKeyPem),
    privateKey,
    publicKey,
    publicKeyPem,
    privateKeyPem,
  };
}

/**
 * Load a pre-provisioned keypair. Development/test may bootstrap a keypair only
 * when all three files are absent. Production and partial/corrupt states always
 * fail closed; they never silently rotate the signer behind Bay's pinned map.
 */
export function loadOrGenerateFarmKeys(keyDir: string): FarmKeyPair {
  const idPath = join(keyDir, "farm-key-id");
  const privatePath = join(keyDir, "farm-private.pem");
  const publicPath = join(keyDir, "farm-public.pem");
  const presence = [idPath, privatePath, publicPath].map(existsSync);

  if (presence.every(Boolean)) {
    return parseAndValidateKeyPair({
      keyId: readFileSync(idPath, "utf8").trim(),
      privateKeyPem: readFileSync(privatePath, "utf8"),
      publicKeyPem: readFileSync(publicPath, "utf8"),
      privateKeyPath: privatePath,
    });
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "farm signing key files are required in production; refusing to generate or rotate keys implicitly",
    );
  }
  if (presence.some(Boolean)) {
    throw new Error("farm signing key directory is incomplete; refusing to overwrite partial key material");
  }

  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const generated = generateFarmKeyPair();
  writeFileSync(idPath, `${generated.keyId}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(privatePath, generated.privateKeyPem, { mode: 0o600, flag: "wx" });
  writeFileSync(publicPath, generated.publicKeyPem, { mode: 0o644, flag: "wx" });
  return generated;
}

export function buildPublicKeyMapJson(keys: FarmKeyPair[]): string {
  const map: Record<string, string> = {};
  for (const key of keys) map[key.keyId] = key.publicKeyPem;
  return `${JSON.stringify(map, null, 2)}\n`;
}

export function signIdentityAssertion(input: {
  sri: string;
  sidecarCode: string;
  composeProject: string;
  networkAlias: string;
  port: number;
  containerId: string;
  generation: number;
  validitySeconds: number;
  keyPair: FarmKeyPair;
  now?: Date;
}): SignedAssertionResult {
  if (!input.containerId) throw new Error("containerId is required for IdentityAssertion signing");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("IdentityAssertion generation must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("IdentityAssertion port must be an integer between 1 and 65535");
  }
  if (!Number.isSafeInteger(input.validitySeconds) || input.validitySeconds < 1) {
    throw new Error("IdentityAssertion validitySeconds must be a positive safe integer");
  }

  const issuedAt = input.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + input.validitySeconds * 1000);
  const unsigned: Omit<IdentityAssertionFields, "farmSignature"> = {
    sri: input.sri,
    sidecarCode: input.sidecarCode,
    composeProject: input.composeProject,
    networkAlias: input.networkAlias,
    port: input.port,
    containerId: input.containerId,
    generation: input.generation,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    keyId: input.keyPair.keyId,
    bindingSecret: randomBytes(32).toString("hex"),
  };
  const record: IdentityAssertionFields = { ...unsigned, farmSignature: "" };
  const canonical = serializeIdentityAssertionCanonical(record);
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), input.keyPair.privateKey);
  if (signature.length !== 64) throw new Error("unexpected Ed25519 signature length");

  return {
    assertion: { ...unsigned, farmSignature: signature.toString("hex") },
    publicKeyPem: input.keyPair.publicKeyPem,
  };
}
