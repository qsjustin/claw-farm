import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AliasRegistry,
  isAliasBoundOnDockerNetwork,
  type AliasReservation,
} from "../alias-registry.ts";

let dir: string;
let registryPath: string;
let nowMs: number;

function now(): Date {
  return new Date(nowMs);
}

function registry(overrides: ConstructorParameters<typeof AliasRegistry>[0] = {}): AliasRegistry {
  return new AliasRegistry({
    path: registryPath,
    now,
    dnsRetentionMs: 60_000,
    claimLeaseMs: 1_000,
    retryBaseMs: 500,
    retryMaxMs: 4_000,
    randomSuffix: () => "cafe",
    ...overrides,
  });
}

async function activeEntry(r: AliasRegistry, input: {
  sri?: string;
  generation?: number;
  expiresInMs?: number;
  externalNetwork?: string;
} = {}): Promise<AliasReservation> {
  const reservation = await r.reserve({
    sri: input.sri ?? "sri-one",
    generation: input.generation ?? 1,
    externalNetwork: input.externalNetwork ?? "clawbay_test",
    assertionExpiresAt: new Date(nowMs + (input.expiresInMs ?? 10_000)).toISOString(),
  });
  expect(await r.activate(reservation)).toBe(true);
  return reservation;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claw-farm-alias-registry-"));
  registryPath = join(dir, "alias-registry.json");
  nowMs = Date.parse("2026-07-24T00:00:00.000Z");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AliasRegistry durable lifecycle", () => {
  it("persists an active reservation and reuses it for the same SRI + generation", async () => {
    const first = registry();
    const reservation = await activeEntry(first);
    const second = registry();
    const reused = await second.reserve({
      sri: "sri-one",
      generation: 1,
      externalNetwork: "clawbay_test",
      assertionExpiresAt: new Date(nowMs + 20_000).toISOString(),
    });

    expect(reused.created).toBe(false);
    expect(reused.networkAlias).toBe(reservation.networkAlias);
    const state = await second.getState("sri-one", 1);
    expect(state?.state).toBe("active");
    expect(state?.maxAssertionExpiresAt).toBe(new Date(nowMs + 20_000).toISOString());
    expect(await readFile(registryPath, "utf8")).toContain(reservation.networkAlias);
  });

  it("keeps released aliases quarantined and allocates a suffix to a new generation", async () => {
    const r = registry();
    const first = await activeEntry(r);
    expect(await r.release({ sri: "sri-one", generation: 1, networkAlias: first.networkAlias })).toBe(true);

    await expect(r.reserve({
      sri: "sri-one",
      generation: 1,
      externalNetwork: "clawbay_test",
      assertionExpiresAt: new Date(nowMs + 30_000).toISOString(),
    })).rejects.toThrow("quarantined");

    const next = await r.reserve({
      sri: "sri-one",
      generation: 2,
      externalNetwork: "clawbay_test",
      assertionExpiresAt: new Date(nowMs + 30_000).toISOString(),
    });
    expect(next.networkAlias).toBe(`${first.networkAlias}-cafe`);
  });

  it("serializes concurrent attach reservations for the same SRI + generation", async () => {
    const r1 = registry();
    const r2 = registry();
    const input = {
      sri: "sri-one",
      generation: 1,
      externalNetwork: "clawbay_test",
      assertionExpiresAt: new Date(nowMs + 10_000).toISOString(),
    };
    const results = await Promise.allSettled([r1.reserve(input), r2.reserve(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await r1.getState("sri-one", 1))?.state).toBe("reserved");
  });

  it("allocates a suffix when different instances collide on the same candidate", async () => {
    const r = registry({ deriveAlias: () => "clawbay-sidecar-collision" });
    const first = await activeEntry(r, { sri: "sri-one" });
    const second = await r.reserve({
      sri: "sri-two",
      generation: 1,
      externalNetwork: "clawbay_test",
      assertionExpiresAt: new Date(nowMs + 10_000).toISOString(),
    });
    expect(first.networkAlias).toBe("clawbay-sidecar-collision");
    expect(second.networkAlias).toBe("clawbay-sidecar-collision-cafe");
  });

  it("does not claim before both assertion expiry and DNS retention have elapsed", async () => {
    const r = registry();
    const reservation = await activeEntry(r, { expiresInMs: 10_000 });
    await r.release({ sri: "sri-one", generation: 1, networkAlias: reservation.networkAlias });

    nowMs += 69_999;
    const result = await r.reconcile({ isAliasInUse: async () => false });
    expect(result.claimed).toBe(0);
    expect((await r.getState("sri-one", 1))?.state).toBe("released");
  });

  it("deletes only after expiry + retention and a no-live-container proof", async () => {
    const r = registry();
    const reservation = await activeEntry(r, { expiresInMs: 10_000 });
    await r.release({ sri: "sri-one", generation: 1, networkAlias: reservation.networkAlias });
    nowMs += 70_000;

    const result = await r.reconcile({ isAliasInUse: async () => false });
    expect(result).toMatchObject({ claimed: 1, deleted: 1, failed: 0, deferred: 0 });
    expect((await r.getState("sri-one", 1))?.state).toBe("deleted");
  });

  it("fails closed when a live container still owns the alias and schedules retry", async () => {
    const r = registry();
    const reservation = await activeEntry(r, { expiresInMs: 0 });
    await r.release({ sri: "sri-one", generation: 1, networkAlias: reservation.networkAlias });
    nowMs += 60_000;

    const result = await r.reconcile({ isAliasInUse: async () => true });
    expect(result).toMatchObject({ deferred: 1, deleted: 0 });
    const state = await r.getState("sri-one", 1);
    expect(state?.state).toBe("released");
    expect(state?.deleteAttempts).toBe(1);
    expect(state?.nextDeleteAttemptAt).toBe(new Date(nowMs + 500).toISOString());
    expect(state?.lastDeleteError).toContain("still bound");
  });

  it("keeps a failed delete quarantined and retries with exponential backoff", async () => {
    const r = registry();
    const reservation = await activeEntry(r, { expiresInMs: 0 });
    await r.release({ sri: "sri-one", generation: 1, networkAlias: reservation.networkAlias });
    nowMs += 60_000;

    const failed = await r.reconcile({
      isAliasInUse: async () => false,
      deleteAlias: async () => { throw new Error("provider cleanup unavailable"); },
    });
    expect(failed.failed).toBe(1);
    expect((await r.getState("sri-one", 1))?.state).toBe("released");

    expect((await r.reconcile({ isAliasInUse: async () => false })).claimed).toBe(0);
    nowMs += 500;
    const retried = await r.reconcile({ isAliasInUse: async () => false });
    expect(retried.deleted).toBe(1);
  });

  it("allows only one concurrent worker to claim an eligible alias", async () => {
    const r1 = registry();
    const r2 = registry();
    const reservation = await activeEntry(r1, { expiresInMs: 0 });
    await r1.release({ sri: "sri-one", generation: 1, networkAlias: reservation.networkAlias });
    nowMs += 60_000;
    let inspections = 0;
    const inspect = async () => { inspections += 1; return false; };

    const [a, b] = await Promise.all([
      r1.reconcile({ isAliasInUse: inspect }),
      r2.reconcile({ isAliasInUse: inspect }),
    ]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.deleted + b.deleted).toBe(1);
    expect(inspections).toBe(1);
  });

  it("rejects a stale completion after an expired claim is taken by a new owner", async () => {
    const first = registry();
    const second = registry();
    const reservation = await activeEntry(first, { expiresInMs: 0 });
    await first.release({ sri: "sri-one", generation: 1, networkAlias: reservation.networkAlias });
    nowMs += 60_000;

    let allowFirstDelete!: () => void;
    const firstDeleteGate = new Promise<void>((resolve) => { allowFirstDelete = resolve; });
    const firstRun = first.reconcile({
      isAliasInUse: async () => false,
      deleteAlias: async () => firstDeleteGate,
    });

    // Let the first worker persist its claim before advancing beyond the lease.
    for (let i = 0; i < 100; i++) {
      if ((await first.getState("sri-one", 1))?.state === "deleting") break;
      await Bun.sleep(1);
    }
    nowMs += 1_001;
    const secondRun = await second.reconcile({ isAliasInUse: async () => false });
    expect(secondRun.deleted).toBe(1);

    allowFirstDelete();
    const stale = await firstRun;
    expect(stale.deleted).toBe(0);
    expect(stale.staleCompletions).toBe(1);
    expect((await first.getState("sri-one", 1))?.state).toBe("deleted");
  });

  it("uses reservation ownership CAS for activation and rollback", async () => {
    const r = registry();
    const reservation = await r.reserve({
      sri: "sri-one",
      generation: 1,
      externalNetwork: "clawbay_test",
      assertionExpiresAt: new Date(nowMs + 10_000).toISOString(),
    });
    const stale = { ...reservation, reservationToken: "wrong-owner" };
    expect(await r.activate(stale)).toBe(false);
    expect(await r.cancelReservation(stale)).toBe(false);
    expect((await r.getState("sri-one", 1))?.state).toBe("reserved");
    expect(await r.activate(reservation)).toBe(true);
  });

  it("fails closed on a corrupted registry instead of resetting aliases", async () => {
    await writeFile(registryPath, "{not-json", { mode: 0o600 });
    await expect(registry().list()).rejects.toThrow();
    expect(await readFile(registryPath, "utf8")).toBe("{not-json");
  });
});

describe("isAliasBoundOnDockerNetwork", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => { originalSpawn = Bun.spawn; });
  afterEach(() => { Bun.spawn = originalSpawn; });

  it("finds an alias by inspecting each network container", async () => {
    Bun.spawn = ((args: string[]) => {
      const isNetwork = args[1] === "network";
      const stdout = isNetwork
        ? JSON.stringify({ abc123: { Name: "sidecar" } })
        : JSON.stringify({ clawbay_test: { Aliases: ["container-name", "clawbay-sidecar-deadbeef0000"] } });
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([stdout]).stream(),
        stderr: new Blob([""]).stream(),
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    expect(await isAliasBoundOnDockerNetwork("clawbay-sidecar-deadbeef0000", "clawbay_test")).toBe(true);
  });

  it("fails closed when Docker inspection fails", async () => {
    Bun.spawn = (() => ({
      exited: Promise.resolve(1),
      stdout: new Blob([""]).stream(),
      stderr: new Blob(["permission denied"]).stream(),
    }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

    await expect(isAliasBoundOnDockerNetwork("clawbay-sidecar-deadbeef0000", "clawbay_test"))
      .rejects.toThrow("docker network inspect failed");
  });
});
