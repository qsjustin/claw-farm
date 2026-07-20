/**
 * #179 implementation: tests for the farm-side `IdentityAssertion`
 * builder / signer.
 *
 * Per the approved #177 contract, the canonical assertion
 * must:
 * 1. Produce a stable canonical JSON for signing (deterministic
 *    key order, no extra fields).
 * 2. Sign and verify round-trip with constant-time comparison.
 * 3. Reject length-mismatched signatures.
 * 4. Reject any field tampering (changing any signed field
 *    invalidates the signature).
 * 5. `generateBindingSecret` produces a CSPRNG secret of the
 *    requested byte length and rejects sizes < 32.
 *
 * `bindingSecret` exposure rules are exercised separately in
 * the dispatch tests (no labels / logs / etc).
 */

import { describe, expect, it } from "bun:test";

import {
  buildIdentityAssertion,
  currentKeyId,
  generateBindingSecret,
  serializeCanonical,
  signIdentityAssertion,
  verifyIdentityAssertion,
  type IdentityAssertion,
} from "../identity-assertion";

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

function buildFixture(): IdentityAssertion {
  return buildIdentityAssertion(FIXTURE_FIELDS);
}

describe("identity-assertion: canonical bytes", () => {
  it("serializeCanonical emits keys in canonical order", () => {
    const record = buildFixture();
    const canonical = serializeCanonical(record);
    // Keys in the documented canonical order
    const expectedPrefix = `{"sri":"${FIXTURE_FIELDS.sri}","sidecarCode":"weixin-auth-sidecar","composeProject":"${FIXTURE_FIELDS.composeProject}"`;
    expect(canonical.startsWith(expectedPrefix)).toBe(true);
  });

  it("serializeCanonical is deterministic across calls", () => {
    const r1 = buildFixture();
    const r2 = buildFixture();
    // Two builds differ in `issuedAt` (call time) and
    // `farmSignature`; we strip both for the determinism
    // check.
    const strip = (r: IdentityAssertion) => ({
      ...r,
      issuedAt: "STRIPPED",
      farmSignature: "STRIPPED",
    });
    expect(serializeCanonical(strip(r1))).toBe(
      serializeCanonical(strip(r2))
    );
  });

  it("serializeCanonical excludes farmSignature from the signed payload", () => {
    const record = buildFixture();
    const canonical = serializeCanonical(record);
    // farmSignature is excluded from the signed payload (per
    // the contract: it is the signature itself; including
    // it would make the signature self-referential and
    // unverifiable). The canonical bytes are 11 fields,
    // not 12.
    expect(canonical).not.toContain("farmSignature");
    expect(canonical).toContain("sri");
    expect(canonical).toContain("bindingSecret");
  });
});

describe("identity-assertion: sign / verify", () => {
  it("verifyIdentityAssertion returns true for a fresh signature", () => {
    const record = buildFixture();
    expect(verifyIdentityAssertion(record)).toBe(true);
  });

  it("verifyIdentityAssertion returns false if any signed field is tampered with", () => {
    const record = buildFixture();
    const tampered: IdentityAssertion[] = [
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
      expect(verifyIdentityAssertion(t)).toBe(false);
    }
  });

  it("verifyIdentityAssertion returns false for a length-mismatched farmSignature", () => {
    const record = buildFixture();
    const bad: IdentityAssertion = {
      ...record,
      farmSignature: "abcd", // way too short
    };
    expect(verifyIdentityAssertion(bad)).toBe(false);
  });

  it("verifyIdentityAssertion returns false for a same-length wrong signature", () => {
    const record = buildFixture();
    const wrongSig = "00".repeat(record.farmSignature.length / 2);
    const bad: IdentityAssertion = { ...record, farmSignature: wrongSig };
    expect(verifyIdentityAssertion(bad)).toBe(false);
  });

  it("signIdentityAssertion is deterministic for the same canonical bytes", () => {
    const a = signIdentityAssertion({
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
    const b = signIdentityAssertion({
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
    const s = generateBindingSecret(32);
    expect(s).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(s)).toBe(true);
  });

  it("default byte length is 32", () => {
    const s = generateBindingSecret();
    expect(s).toHaveLength(64);
  });

  it("rejects byteLength < 32", () => {
    expect(() => generateBindingSecret(16)).toThrow(/byteLength must be >= 32/);
    expect(() => generateBindingSecret(0)).toThrow();
  });

  it("returns different values on repeated calls (CSPRNG)", () => {
    const a = generateBindingSecret();
    const b = generateBindingSecret();
    expect(a).not.toBe(b);
  });
});

describe("identity-assertion: buildIdentityAssertion shape", () => {
  it("emits all 12 fields with the correct shape", () => {
    const record = buildFixture();
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
    expect(record.farmSignature.length).toBeGreaterThan(0);
  });

  it("uses currentKeyId()", () => {
    const record = buildFixture();
    expect(record.keyId).toBe(currentKeyId());
  });

  it("issuedAt and expiresAt are ISO 8601 strings", () => {
    const record = buildFixture();
    expect(record.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(record.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
