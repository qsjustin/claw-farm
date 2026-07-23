import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createPublicKey,
  generateKeyPairSync,
  verify as cryptoVerify,
} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildPublicKeyMapJson,
  generateFarmKeyPair,
  loadOrGenerateFarmKeys,
  serializeIdentityAssertionCanonical,
  signIdentityAssertion,
  type FarmKeyPair,
  type IdentityAssertionFields,
} from "../identity-assertion.ts";

let dir: string;
let originalNodeEnv: string | undefined;

function sign(keyPair: FarmKeyPair, overrides: Partial<Parameters<typeof signIdentityAssertion>[0]> = {}) {
  return signIdentityAssertion({
    sri: "sri-one",
    sidecarCode: "weixin-auth-sidecar",
    composeProject: "clawbay-project-user",
    networkAlias: "clawbay-sidecar-deadbeef0000",
    port: 8787,
    containerId: "abcdef012345",
    generation: 1,
    validitySeconds: 3600,
    now: new Date("2026-07-24T00:00:00.000Z"),
    keyPair,
    ...overrides,
  });
}

function verify(assertion: IdentityAssertionFields, publicKeyPem: string): boolean {
  return cryptoVerify(
    null,
    Buffer.from(serializeIdentityAssertionCanonical(assertion), "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(assertion.farmSignature, "hex"),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claw-farm-identity-"));
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  await rm(dir, { recursive: true, force: true });
});

describe("IdentityAssertion canonical signer", () => {
  it("signs the exact #177 canonical JSON including bindingSecret as lowercase hex", () => {
    const keyPair = generateFarmKeyPair();
    const { assertion } = sign(keyPair);
    expect(assertion.farmSignature).toMatch(/^[0-9a-f]{128}$/);
    expect(assertion.bindingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(serializeIdentityAssertionCanonical(assertion)).toContain(`"bindingSecret":"${assertion.bindingSecret}"`);
    expect(verify(assertion, keyPair.publicKeyPem)).toBe(true);
  });

  it("cryptographically binds bindingSecret, SRI, generation, alias, and container identity", () => {
    const keyPair = generateFarmKeyPair();
    const { assertion } = sign(keyPair);
    for (const tampered of [
      { ...assertion, bindingSecret: "00".repeat(32) },
      { ...assertion, sri: "sri-two" },
      { ...assertion, generation: 2 },
      { ...assertion, networkAlias: `${assertion.networkAlias}-other` },
      { ...assertion, containerId: "ffffffffffff" },
    ]) {
      expect(verify(tampered, keyPair.publicKeyPem)).toBe(false);
    }
  });

  it("rejects missing container identity and invalid numeric bounds", () => {
    const keyPair = generateFarmKeyPair();
    expect(() => sign(keyPair, { containerId: "" })).toThrow("containerId");
    expect(() => sign(keyPair, { generation: 0 })).toThrow("generation");
    expect(() => sign(keyPair, { port: 0 })).toThrow("port");
  });

  it("verifies in a fresh public-only child process", async () => {
    const keyPair = generateFarmKeyPair();
    const { assertion } = sign(keyPair);
    const assertionPath = join(dir, "assertion.json");
    const publicMapPath = join(dir, "public-map.json");
    await writeFile(assertionPath, JSON.stringify(assertion), { mode: 0o600 });
    await writeFile(publicMapPath, buildPublicKeyMapJson([keyPair]), { mode: 0o600 });

    const script = `
      import { createPublicKey, verify } from "node:crypto";
      import { readFileSync } from "node:fs";
      const record = JSON.parse(readFileSync(process.env.ASSERTION_PATH, "utf8"));
      const map = JSON.parse(readFileSync(process.env.PUBLIC_MAP_PATH, "utf8"));
      const order = ["sri","sidecarCode","composeProject","networkAlias","port","containerId","generation","issuedAt","expiresAt","keyId","bindingSecret"];
      const canonical = "{" + order.map(k => JSON.stringify(k) + ":" + JSON.stringify(record[k])).join(",") + "}";
      const ok = verify(null, Buffer.from(canonical), createPublicKey(map[record.keyId]), Buffer.from(record.farmSignature, "hex"));
      process.exit(ok ? 0 : 2);
    `;
    const proc = Bun.spawn(["bun", "-e", script], {
      env: {
        PATH: process.env.PATH ?? "",
        ASSERTION_PATH: assertionPath,
        PUBLIC_MAP_PATH: publicMapPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe("");
  });
});

describe("Farm signing key lifecycle", () => {
  it("bootstraps only in test/dev and reloads the same keypair", () => {
    const first = loadOrGenerateFarmKeys(dir);
    const second = loadOrGenerateFarmKeys(dir);
    expect(second.keyId).toBe(first.keyId);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(sign(second).assertion.keyId).toBe(first.keyId);
  });

  it("fails closed on missing production key files", () => {
    process.env.NODE_ENV = "production";
    expect(() => loadOrGenerateFarmKeys(dir)).toThrow("required in production");
  });

  it("fails closed on partial key material instead of silently rotating", async () => {
    await writeFile(join(dir, "farm-key-id"), "partial\n", { mode: 0o600 });
    expect(() => loadOrGenerateFarmKeys(dir)).toThrow("incomplete");
  });

  it("rejects group/world-readable production private keys", async () => {
    const keyPair = loadOrGenerateFarmKeys(dir);
    await chmod(join(dir, "farm-private.pem"), 0o644);
    process.env.NODE_ENV = "production";
    expect(() => loadOrGenerateFarmKeys(dir)).toThrow("group/other");
    expect(keyPair.publicKeyPem).toContain("PUBLIC KEY");
  });

  it("rejects malformed, non-Ed25519, and mismatched key files", async () => {
    const keyPair = loadOrGenerateFarmKeys(dir);
    await writeFile(join(dir, "farm-private.pem"), "not a key", { mode: 0o600 });
    expect(() => loadOrGenerateFarmKeys(dir)).toThrow("PKCS8");

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(join(dir, "farm-private.pem"), rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    await writeFile(join(dir, "farm-public.pem"), rsa.publicKey.export({ type: "spki", format: "pem" }) as string, { mode: 0o644 });
    expect(() => loadOrGenerateFarmKeys(dir)).toThrow("Ed25519");

    const other = generateFarmKeyPair();
    await writeFile(join(dir, "farm-private.pem"), keyPair.privateKeyPem, { mode: 0o600 });
    await writeFile(join(dir, "farm-public.pem"), other.publicKeyPem, { mode: 0o644 });
    expect(() => loadOrGenerateFarmKeys(dir)).toThrow("matching");
  });

  it("exports a rotation map with both key IDs and no private material", async () => {
    const first = generateFarmKeyPair();
    const second = generateFarmKeyPair();
    const json = buildPublicKeyMapJson([first, second]);
    const parsed = JSON.parse(json) as Record<string, string>;
    expect(Object.keys(parsed).sort()).toEqual([first.keyId, second.keyId].sort());
    expect(json).not.toContain("PRIVATE KEY");
    await mkdir(join(dir, "map"), { recursive: true });
    await writeFile(join(dir, "map", "keys.json"), json, { mode: 0o600 });
    expect(await readFile(join(dir, "map", "keys.json"), "utf8")).toBe(json);
  });
});
