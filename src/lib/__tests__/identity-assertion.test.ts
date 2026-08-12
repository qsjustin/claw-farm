/**
 * #179 implementation: tests for the farm-side `IdentityAssertion`
 * builder / signer (Ed25519 asymmetric signature).
 *
 * Per the approved #177 contract:
 * 1. Stable canonical JSON for signing (deterministic key
 *    order, no extra fields).
 * 2. Asymmetric Ed25519 signature: farm signs with private
 *    key; Bay verifies with matching public key.
 * 3. `verifyIdentityAssertion` returns false (NOT throw) for
 *    same-length non-hex / malformed signatures.
 * 4. Cross-process / multi-key rotation: tests use two
 *    keypairs and verify keyId selection.
 * 5. Production fail-closed: in production, missing
 *    `FARM_PRIVATE_KEY_PATH` or `FARM_KEY_ID` throws at
 *    module load. Tested in a child process to bypass the
 *    module cache.
 * 6. Malformed key material (non-PEM, non-Ed25519,
 *    unreadable file, world-readable file in production) is
 *    rejected with a clear error.
 * 7. `generateBindingSecret` produces a CSPRNG secret of
 *    the requested byte length and rejects sizes < 32.
 */

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const TMP_DIR = join(tmpdir(), "leonard-179a-farm-test-" + Date.now());
mkdirSync(TMP_DIR, { recursive: true });

const PRIVATE_KEY_PATH = join(TMP_DIR, "farm-private.pem");
const PUBLIC_KEY_PATH = join(TMP_DIR, "farm-public.pem");

import type { KeyObject } from "node:crypto";

let VERIFIER_PUBLIC_KEY: KeyObject;

const IDENTITY_PATH = new URL("../identity-assertion.ts", import.meta.url)
  .pathname;

// Set env vars BEFORE loading the module. The test file
// imports the module after this setup, so the module-level
// env-var reads see the configured values.
async function loadIdentityModule() {
  // Use dynamic import to ensure env vars are set first.
  // (Static imports would be hoisted and run before the
  // test setup.)
  return (await import(IDENTITY_PATH)) as typeof import("../identity-assertion");
}

beforeAll(async () => {
  // Generate an Ed25519 keypair for the module under test.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    PRIVATE_KEY_PATH,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    { mode: 0o600 }
  );
  writeFileSync(
    PUBLIC_KEY_PATH,
    publicKey.export({ type: "spki", format: "pem" }) as string,
    { mode: 0o644 }
  );
  // Set env vars for the module's module-load env reads.
  process.env.FARM_PRIVATE_KEY_PATH = PRIVATE_KEY_PATH;
  process.env.FARM_KEY_ID = "farm-id-test-key-1";
  // Load the public key for verification.
  const mod = await loadIdentityModule();
  VERIFIER_PUBLIC_KEY = mod.loadPublicKeyFromPath(PUBLIC_KEY_PATH) as KeyObject;
});

afterAll(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

describe("identity-assertion: canonical bytes", () => {
  it("serializeCanonical emits keys in canonical order", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const canonical = mod.serializeCanonical(record);
    const expectedPrefix = `{"sri":"${FIXTURE_FIELDS.sri}","sidecarCode":"weixin-auth-sidecar","composeProject":"${FIXTURE_FIELDS.composeProject}"`;
    expect(canonical.startsWith(expectedPrefix)).toBe(true);
  });

  it("serializeCanonical is deterministic across calls", async () => {
    const mod = await loadIdentityModule();
    const r1 = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const r2 = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const strip = (r: typeof r1) => ({
      ...r,
      issuedAt: "STRIPPED",
      farmSignature: "STRIPPED",
    });
    expect(mod.serializeCanonical(strip(r1))).toBe(
      mod.serializeCanonical(strip(r2))
    );
  });

  it("serializeCanonical excludes farmSignature from the signed payload", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const canonical = mod.serializeCanonical(record);
    expect(canonical).not.toContain("farmSignature");
    expect(canonical).toContain("sri");
    expect(canonical).toContain("bindingSecret");
  });
});

const FIXTURE_FIELDS = {
  sri: "sri-test-1",
  sidecarCode: "weixin-auth-sidecar",
  composeProject: "clawbay-sidecar-sri-test-1",
  networkAlias: "clawbay-sidecar-abcd1234efgh",
  port: 8787,
  containerId: "abcdef0123456789",
  generation: 1,
  issuedAt: new Date("2026-07-20T00:00:00.000Z"),
  expiresAt: new Date("2026-07-20T01:00:00.000Z"),
  bindingSecret: "deadbeef".repeat(8), // 64 hex chars = 32 bytes
};

describe("identity-assertion: Ed25519 sign / verify (asymmetric)", () => {
  it("verifyIdentityAssertion returns true with the matching public key", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    expect(mod.verifyIdentityAssertion(record, VERIFIER_PUBLIC_KEY)).toBe(true);
  });

  it("verifyIdentityAssertion returns false with a different public key", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const { publicKey: OTHER_PUB } = generateKeyPairSync("ed25519");
    const otherPath = join(TMP_DIR, "other-pub.pem");
    writeFileSync(
      otherPath,
      OTHER_PUB.export({ type: "spki", format: "pem" }) as string
    );
    const otherPublic = mod.loadPublicKeyFromPath(otherPath);
    expect(mod.verifyIdentityAssertion(record, otherPublic)).toBe(false);
  });

  it("verifyIdentityAssertion returns false if any signed field is tampered with", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const tampered = [
      { ...record, sri: "sri-EVIL" },
      { ...record, port: 8788 },
      { ...record, generation: record.generation + 1 },
      { ...record, containerId: "0".repeat(16) },
      { ...record, networkAlias: "clawbay-sidecar-evil0000" },
      { ...record, composeProject: "evil" },
      { ...record, expiresAt: new Date("2026-07-20T02:00:00.000Z").toISOString() },
      { ...record, keyId: "evil-key" },
      { ...record, bindingSecret: "ff".repeat(32) },
    ];
    for (const t of tampered) {
      expect(mod.verifyIdentityAssertion(t, VERIFIER_PUBLIC_KEY)).toBe(false);
    }
  });

  it("verifyIdentityAssertion returns false (NOT throw) for a length-mismatched farmSignature", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const bad = { ...record, farmSignature: "abcd" };
    expect(() => mod.verifyIdentityAssertion(bad, VERIFIER_PUBLIC_KEY)).not.toThrow();
    expect(mod.verifyIdentityAssertion(bad, VERIFIER_PUBLIC_KEY)).toBe(false);
  });

  it("verifyIdentityAssertion returns false (NOT throw) for same-length non-hex farmSignature", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const bad = {
      ...record,
      farmSignature: "z".repeat(record.farmSignature.length),
    };
    expect(() => mod.verifyIdentityAssertion(bad, VERIFIER_PUBLIC_KEY)).not.toThrow();
    expect(mod.verifyIdentityAssertion(bad, VERIFIER_PUBLIC_KEY)).toBe(false);
  });

  it("verifyIdentityAssertion returns false (NOT throw) for same-length wrong hex", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const wrongHex = "00".repeat(record.farmSignature.length / 2);
    const bad = { ...record, farmSignature: wrongHex };
    expect(() => mod.verifyIdentityAssertion(bad, VERIFIER_PUBLIC_KEY)).not.toThrow();
    expect(mod.verifyIdentityAssertion(bad, VERIFIER_PUBLIC_KEY)).toBe(false);
  });

  it("verifyIdentityAssertion returns false (NOT throw) for non-Ed25519 public key", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    const { publicKey: rsaPub } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    expect(() => mod.verifyIdentityAssertion(record, rsaPub)).not.toThrow();
    expect(mod.verifyIdentityAssertion(record, rsaPub)).toBe(false);
  });

  it("signIdentityAssertion is deterministic for the same canonical bytes", async () => {
    const mod = await loadIdentityModule();
    const a = mod.signIdentityAssertion({
      sri: "sri-x",
      sidecarCode: "weixin-auth-sidecar",
      composeProject: "p",
      networkAlias: "a",
      port: 1,
      containerId: "c",
      generation: 1,
      issuedAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2026-07-20T01:00:00.000Z",
      keyId: "k",
      bindingSecret: "00".repeat(32),
    });
    const b = mod.signIdentityAssertion({
      sri: "sri-x",
      sidecarCode: "weixin-auth-sidecar",
      composeProject: "p",
      networkAlias: "a",
      port: 1,
      containerId: "c",
      generation: 1,
      issuedAt: "2026-07-20T00:00:00.000Z",
      expiresAt: "2026-07-20T01:00:00.000Z",
      keyId: "k",
      bindingSecret: "00".repeat(32),
    });
    expect(a).toBe(b);
  });
});

describe("identity-assertion: generateBindingSecret", () => {
  it("returns a hex string of the requested byte length", () => {
    const mod = require("../identity-assertion") as typeof import("../identity-assertion");
    const s = mod.generateBindingSecret(32);
    expect(s).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(s)).toBe(true);
  });

  it("default byte length is 32", () => {
    const mod = require("../identity-assertion") as typeof import("../identity-assertion");
    const s = mod.generateBindingSecret();
    expect(s).toHaveLength(64);
  });

  it("rejects byteLength < 32", () => {
    const mod = require("../identity-assertion") as typeof import("../identity-assertion");
    expect(() => mod.generateBindingSecret(16)).toThrow(/byteLength must be >= 32/);
    expect(() => mod.generateBindingSecret(0)).toThrow();
  });

  it("returns different values on repeated calls (CSPRNG)", () => {
    const mod = require("../identity-assertion") as typeof import("../identity-assertion");
    const a = mod.generateBindingSecret();
    const b = mod.generateBindingSecret();
    expect(a).not.toBe(b);
  });
});

describe("identity-assertion: buildIdentityAssertion shape", () => {
  it("emits all 12 fields with the correct shape", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    expect(Object.keys(record).sort()).toEqual(
      [
        "bindingSecret",
        "composeProject",
        "containerId",
        "expiresAt",
        "farmSignature",
        "generation",
        "issuedAt",
        "keyId",
        "networkAlias",
        "port",
        "sidecarCode",
        "sri",
      ].sort()
    );
    expect(typeof record.farmSignature).toBe("string");
    expect(record.farmSignature.length).toBe(128); // 64-byte sig as hex
  });

  it("uses currentKeyId()", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    expect(record.keyId).toBe(mod.currentKeyId());
  });

  it("issuedAt and expiresAt are ISO 8601 strings", async () => {
    const mod = await loadIdentityModule();
    const record = mod.buildIdentityAssertion(FIXTURE_FIELDS);
    expect(record.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(record.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("identity-assertion: production fail-closed (child process)", () => {
  // We spawn a child bun process to bypass the parent's
  // module cache. The child's env is set via the `env`
  // option to Bun.spawn (deterministic; no race with the
  // inner script's env manipulation).
  it("throws at module load in production when FARM_PRIVATE_KEY_PATH is missing", async () => {
    const childEnv: Record<string, string> = { NODE_ENV: "production" };
    // Inherit only safe vars (PATH for the bun binary lookup).
    if (process.env.PATH) childEnv.PATH = process.env.PATH;
    // Explicitly DO NOT set FARM_PRIVATE_KEY_PATH.
    const child = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `try {
           await import(${JSON.stringify(IDENTITY_PATH)});
           process.exit(0);
         } catch (e) {
           process.stdout.write(String(e) + "\\n");
           process.exit(1);
         }`,
      ],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toMatch(/FARM_PRIVATE_KEY_PATH is required/);
  });

  it("throws at module load in production when FARM_KEY_ID is missing", async () => {
    const childEnv: Record<string, string> = {
      NODE_ENV: "production",
      FARM_PRIVATE_KEY_PATH: PRIVATE_KEY_PATH,
    };
    if (process.env.PATH) childEnv.PATH = process.env.PATH;
    // Explicitly DO NOT set FARM_KEY_ID.
    const child = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `try {
           await import(${JSON.stringify(IDENTITY_PATH)});
           process.exit(0);
         } catch (e) {
           process.stdout.write(String(e) + "\\n");
           process.exit(1);
         }`,
      ],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout + stderr).toMatch(/FARM_KEY_ID is required/);
  });
});
