import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

import { deriveNetworkAlias } from "./identity-assertion.ts";

export type AliasRegistryState = "reserved" | "active" | "released" | "deleting" | "deleted";

export interface AliasRegistryEntry {
  sri: string;
  generation: number;
  networkAlias: string;
  externalNetwork: string;
  state: AliasRegistryState;
  reservationToken: string | null;
  maxAssertionExpiresAt: string;
  assertionRevokedAt: string | null;
  releasedAt: string | null;
  deleteClaimToken: string | null;
  deleteClaimUntil: string | null;
  deleteAttempts: number;
  nextDeleteAttemptAt: string | null;
  lastDeleteError: string | null;
  revision: number;
}

interface AliasRegistryFile {
  version: 1;
  entries: Record<string, AliasRegistryEntry>;
}

export interface AliasReservation {
  sri: string;
  generation: number;
  networkAlias: string;
  externalNetwork: string;
  reservationToken: string | null;
  created: boolean;
}

export interface AliasReconcileResult {
  examined: number;
  claimed: number;
  deleted: number;
  deferred: number;
  failed: number;
  staleCompletions: number;
}

export interface AliasRegistryOptions {
  path?: string;
  dnsRetentionMs?: number;
  claimLeaseMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  randomSuffix?: () => string;
  deriveAlias?: (sri: string) => string;
}

export interface AliasReconcileOptions {
  /** Fail-closed check required by #177: true means a live container still owns the alias. */
  isAliasInUse: (entry: Readonly<AliasRegistryEntry>) => Promise<boolean>;
  /** Optional provider cleanup hook. A failure leaves the alias quarantined and retryable. */
  deleteAlias?: (entry: Readonly<AliasRegistryEntry>) => Promise<void>;
  limit?: number;
}

const FILE_VERSION = 1;
const DEFAULT_DNS_RETENTION_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 15 * 60_000;
const MAX_LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

const inProcessLocks = new Map<string, Promise<void>>();

function emptyRegistry(): AliasRegistryFile {
  return { version: FILE_VERSION, entries: {} };
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`alias registry ${label} must be a valid ISO timestamp`);
  }
  return parsed;
}

function validateSafeName(value: string, label: string, max = 128): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value) || value.length > max) {
    throw new Error(`alias registry ${label} is not Docker-safe`);
  }
}

function validateEntry(entry: AliasRegistryEntry): void {
  if (!entry.sri || !Number.isSafeInteger(entry.generation) || entry.generation < 1) {
    throw new Error("alias registry entry has invalid identity");
  }
  validateSafeName(entry.sri, "sri", 128);
  validateSafeName(entry.networkAlias, "networkAlias", 63);
  validateSafeName(entry.externalNetwork, "externalNetwork", 128);
  if (!["reserved", "active", "released", "deleting", "deleted"].includes(entry.state)) {
    throw new Error("alias registry entry has invalid state");
  }
  parseTimestamp(entry.maxAssertionExpiresAt, "maxAssertionExpiresAt");
  if (entry.assertionRevokedAt !== null) parseTimestamp(entry.assertionRevokedAt, "assertionRevokedAt");
  if (entry.releasedAt !== null) parseTimestamp(entry.releasedAt, "releasedAt");
  if (entry.deleteClaimUntil !== null) parseTimestamp(entry.deleteClaimUntil, "deleteClaimUntil");
  if (entry.nextDeleteAttemptAt !== null) parseTimestamp(entry.nextDeleteAttemptAt, "nextDeleteAttemptAt");
  if (!Number.isSafeInteger(entry.deleteAttempts) || entry.deleteAttempts < 0) {
    throw new Error("alias registry entry has invalid deleteAttempts");
  }
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    throw new Error("alias registry entry has invalid revision");
  }
}

async function acquireFileLock(lockPath: string): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          const owner = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
          let ownerAlive = Number.isSafeInteger(owner);
          if (ownerAlive) {
            try {
              process.kill(owner, 0);
            } catch {
              ownerAlive = false;
            }
          }
          if (!ownerAlive) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        }
      } catch {
        // The lock disappeared or could not be inspected. Retry without assuming ownership.
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  throw new Error("could not acquire alias registry lock");
}

async function withPathLock<T>(path: string, callback: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(path) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const chain = previous.then(() => queued);
  inProcessLocks.set(path, chain);
  await previous;

  const lockPath = `${path}.lock`;
  try {
    await acquireFileLock(lockPath);
    return await callback();
  } finally {
    await unlink(lockPath).catch(() => {});
    releaseQueue();
    if (inProcessLocks.get(path) === chain) inProcessLocks.delete(path);
  }
}

export class AliasRegistry {
  private readonly path: string;
  private readonly now: () => Date;
  private readonly randomSuffix: () => string;
  private readonly deriveAlias: (sri: string) => string;
  private readonly dnsRetentionMs: number;
  private readonly claimLeaseMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: AliasRegistryOptions = {}) {
    const registryDir = process.env.CLAW_FARM_REGISTRY_DIR ?? join(homedir(), ".claw-farm");
    this.path = options.path
      ?? process.env.CLAW_FARM_ALIAS_REGISTRY_PATH
      ?? join(registryDir, "alias-registry.json");
    this.now = options.now ?? (() => new Date());
    this.randomSuffix = options.randomSuffix ?? (() => randomBytes(2).toString("hex"));
    this.deriveAlias = options.deriveAlias ?? deriveNetworkAlias;
    this.dnsRetentionMs = options.dnsRetentionMs ?? DEFAULT_DNS_RETENTION_MS;
    this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  private key(sri: string, generation: number): string {
    return `${sri}:${generation}`;
  }

  private async load(): Promise<AliasRegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as AliasRegistryFile;
      if (parsed.version !== FILE_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
        throw new Error("alias registry has unsupported schema");
      }
      for (const entry of Object.values(parsed.entries)) validateEntry(entry);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
      throw error;
    }
  }

  private async save(registry: AliasRegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async reserve(input: {
    sri: string;
    generation: number;
    externalNetwork: string;
    assertionExpiresAt: string;
  }): Promise<AliasReservation> {
    validateSafeName(input.sri, "sri", 128);
    validateSafeName(input.externalNetwork, "externalNetwork", 128);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error("alias registry generation must be a positive safe integer");
    }
    parseTimestamp(input.assertionExpiresAt, "assertionExpiresAt");

    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const key = this.key(input.sri, input.generation);
      const existing = registry.entries[key];
      if (existing && existing.state !== "deleted") {
        if (existing.externalNetwork !== input.externalNetwork) {
          throw new Error("alias reservation network mismatch");
        }
        if (existing.state === "active") {
          if (Date.parse(input.assertionExpiresAt) > Date.parse(existing.maxAssertionExpiresAt)) {
            existing.maxAssertionExpiresAt = input.assertionExpiresAt;
            existing.revision += 1;
            await this.save(registry);
          }
          return {
            sri: existing.sri,
            generation: existing.generation,
            networkAlias: existing.networkAlias,
            externalNetwork: existing.externalNetwork,
            reservationToken: null,
            created: false,
          };
        }
        throw new Error(`alias generation is quarantined in state ${existing.state}`);
      }

      const occupied = new Set(
        Object.values(registry.entries)
          .filter((entry) => entry.state !== "deleted" && entry.externalNetwork === input.externalNetwork)
          .map((entry) => entry.networkAlias),
      );
      const baseAlias = this.deriveAlias(input.sri);
      validateSafeName(baseAlias, "derived networkAlias", 58);
      let networkAlias = baseAlias;
      for (let attempt = 0; occupied.has(networkAlias); attempt++) {
        if (attempt >= 128) throw new Error("could not allocate an unoccupied sidecar alias");
        const suffix = this.randomSuffix();
        if (!/^[0-9a-f]{4}$/i.test(suffix)) throw new Error("alias suffix generator returned invalid data");
        networkAlias = `${baseAlias}-${suffix.toLowerCase()}`;
      }

      const reservationToken = randomUUID();
      registry.entries[key] = {
        sri: input.sri,
        generation: input.generation,
        networkAlias,
        externalNetwork: input.externalNetwork,
        state: "reserved",
        reservationToken,
        maxAssertionExpiresAt: input.assertionExpiresAt,
        assertionRevokedAt: null,
        releasedAt: null,
        deleteClaimToken: null,
        deleteClaimUntil: null,
        deleteAttempts: 0,
        nextDeleteAttemptAt: null,
        lastDeleteError: null,
        revision: (existing?.revision ?? 0) + 1,
      };
      await this.save(registry);
      return {
        sri: input.sri,
        generation: input.generation,
        networkAlias,
        externalNetwork: input.externalNetwork,
        reservationToken,
        created: true,
      };
    });
  }

  async activate(reservation: AliasReservation): Promise<boolean> {
    if (!reservation.created || !reservation.reservationToken) return true;
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(reservation.sri, reservation.generation)];
      if (
        !entry
        || entry.state !== "reserved"
        || entry.networkAlias !== reservation.networkAlias
        || entry.reservationToken !== reservation.reservationToken
      ) return false;
      entry.state = "active";
      entry.reservationToken = null;
      entry.revision += 1;
      await this.save(registry);
      return true;
    });
  }

  async cancelReservation(reservation: AliasReservation): Promise<boolean> {
    if (!reservation.created || !reservation.reservationToken) return false;
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(reservation.sri, reservation.generation)];
      if (
        !entry
        || entry.state !== "reserved"
        || entry.networkAlias !== reservation.networkAlias
        || entry.reservationToken !== reservation.reservationToken
      ) return false;
      entry.state = "deleted";
      entry.reservationToken = null;
      entry.revision += 1;
      await this.save(registry);
      return true;
    });
  }

  async release(input: {
    sri: string;
    generation: number;
    networkAlias?: string;
    assertionsRevoked?: boolean;
  }): Promise<boolean> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(input.sri, input.generation)];
      if (!entry) return false;
      if (input.networkAlias && entry.networkAlias !== input.networkAlias) return false;
      if (entry.state === "released" || entry.state === "deleting" || entry.state === "deleted") {
        return true;
      }
      if (entry.state !== "active") return false;
      const now = this.now().toISOString();
      entry.state = "released";
      entry.releasedAt = now;
      entry.assertionRevokedAt = input.assertionsRevoked ? now : null;
      entry.deleteClaimToken = null;
      entry.deleteClaimUntil = null;
      entry.nextDeleteAttemptAt = null;
      entry.lastDeleteError = null;
      entry.revision += 1;
      await this.save(registry);
      return true;
    });
  }

  async revokeAssertions(sri: string, generation: number): Promise<boolean> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(sri, generation)];
      if (!entry || (entry.state !== "released" && entry.state !== "deleting")) return false;
      entry.assertionRevokedAt = this.now().toISOString();
      entry.revision += 1;
      await this.save(registry);
      return true;
    });
  }

  private eligibleAt(entry: AliasRegistryEntry): number {
    if (!entry.releasedAt) return Number.POSITIVE_INFINITY;
    const assertionGate = entry.assertionRevokedAt
      ? Date.parse(entry.assertionRevokedAt)
      : Date.parse(entry.maxAssertionExpiresAt);
    return Math.max(assertionGate, Date.parse(entry.releasedAt)) + this.dnsRetentionMs;
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryBaseMs * (2 ** Math.max(0, attempt - 1)), this.retryMaxMs);
  }

  private async claimEligible(limit: number): Promise<Array<{ entry: AliasRegistryEntry; token: string }>> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const nowMs = this.now().getTime();
      const claims: Array<{ entry: AliasRegistryEntry; token: string }> = [];
      for (const entry of Object.values(registry.entries)) {
        if (claims.length >= limit) break;
        const activeClaim = entry.state === "deleting"
          && entry.deleteClaimUntil !== null
          && Date.parse(entry.deleteClaimUntil) > nowMs;
        if (activeClaim) continue;
        if (entry.state !== "released" && entry.state !== "deleting") continue;
        if (nowMs < this.eligibleAt(entry)) continue;
        if (entry.nextDeleteAttemptAt && nowMs < Date.parse(entry.nextDeleteAttemptAt)) continue;

        const token = randomUUID();
        entry.state = "deleting";
        entry.deleteClaimToken = token;
        entry.deleteClaimUntil = new Date(nowMs + this.claimLeaseMs).toISOString();
        entry.revision += 1;
        claims.push({ entry: structuredClone(entry), token });
      }
      if (claims.length > 0) await this.save(registry);
      return claims;
    });
  }

  private async finalizeDelete(claim: { entry: AliasRegistryEntry; token: string }): Promise<boolean> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(claim.entry.sri, claim.entry.generation)];
      if (
        !entry
        || entry.state !== "deleting"
        || entry.networkAlias !== claim.entry.networkAlias
        || entry.deleteClaimToken !== claim.token
      ) return false;
      entry.state = "deleted";
      entry.deleteClaimToken = null;
      entry.deleteClaimUntil = null;
      entry.nextDeleteAttemptAt = null;
      entry.lastDeleteError = null;
      entry.revision += 1;
      await this.save(registry);
      return true;
    });
  }

  private async failDelete(
    claim: { entry: AliasRegistryEntry; token: string },
    error: unknown,
  ): Promise<boolean> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(claim.entry.sri, claim.entry.generation)];
      if (
        !entry
        || entry.state !== "deleting"
        || entry.networkAlias !== claim.entry.networkAlias
        || entry.deleteClaimToken !== claim.token
      ) return false;
      entry.state = "released";
      entry.deleteAttempts += 1;
      entry.deleteClaimToken = null;
      entry.deleteClaimUntil = null;
      entry.nextDeleteAttemptAt = new Date(
        this.now().getTime() + this.retryDelay(entry.deleteAttempts),
      ).toISOString();
      const message = error instanceof Error ? error.message : String(error);
      entry.lastDeleteError = message.slice(0, 240);
      entry.revision += 1;
      await this.save(registry);
      return true;
    });
  }

  async reconcile(options: AliasReconcileOptions): Promise<AliasReconcileResult> {
    const claims = await this.claimEligible(Math.max(1, options.limit ?? 100));
    const result: AliasReconcileResult = {
      examined: claims.length,
      claimed: claims.length,
      deleted: 0,
      deferred: 0,
      failed: 0,
      staleCompletions: 0,
    };

    await Promise.all(claims.map(async (claim) => {
      try {
        if (await options.isAliasInUse(claim.entry)) {
          result.deferred += 1;
          if (!await this.failDelete(claim, new Error("alias is still bound to a live container"))) {
            result.staleCompletions += 1;
          }
          return;
        }
        if (options.deleteAlias) await options.deleteAlias(claim.entry);
        if (await this.finalizeDelete(claim)) result.deleted += 1;
        else result.staleCompletions += 1;
      } catch (error) {
        result.failed += 1;
        if (!await this.failDelete(claim, error)) result.staleCompletions += 1;
      }
    }));

    return result;
  }

  async getState(sri: string, generation: number): Promise<AliasRegistryEntry | null> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      const entry = registry.entries[this.key(sri, generation)];
      return entry ? structuredClone(entry) : null;
    });
  }

  async list(): Promise<AliasRegistryEntry[]> {
    return withPathLock(this.path, async () => {
      const registry = await this.load();
      return Object.values(registry.entries).map((entry) => structuredClone(entry));
    });
  }
}

/**
 * Inspect the configured Docker network and fail closed on any CLI/parse error.
 * Docker network inspect does not expose per-endpoint aliases, so container IDs
 * are obtained from the network and each container's network aliases are checked.
 */
export async function isAliasBoundOnDockerNetwork(
  networkAlias: string,
  externalNetwork: string,
): Promise<boolean> {
  validateSafeName(networkAlias, "networkAlias", 63);
  validateSafeName(externalNetwork, "externalNetwork", 128);

  const networkProc = Bun.spawn(
    ["docker", "network", "inspect", externalNetwork, "--format", "{{json .Containers}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const networkExit = await networkProc.exited;
  const networkStdout = await new Response(networkProc.stdout).text();
  const networkStderr = await new Response(networkProc.stderr).text();
  if (networkExit !== 0) {
    throw new Error(`docker network inspect failed (${networkExit}): ${networkStderr.trim()}`);
  }

  let containers: Record<string, unknown>;
  try {
    const parsed = JSON.parse(networkStdout.trim() || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("containers payload is not an object");
    }
    containers = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`docker network inspect returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const containerId of Object.keys(containers)) {
    const inspectProc = Bun.spawn(
      ["docker", "inspect", containerId, "--format", "{{json .NetworkSettings.Networks}}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const inspectExit = await inspectProc.exited;
    const inspectStdout = await new Response(inspectProc.stdout).text();
    const inspectStderr = await new Response(inspectProc.stderr).text();
    if (inspectExit !== 0) {
      throw new Error(`docker inspect failed (${inspectExit}): ${inspectStderr.trim()}`);
    }
    let networks: Record<string, { Aliases?: unknown }>;
    try {
      networks = JSON.parse(inspectStdout.trim()) as Record<string, { Aliases?: unknown }>;
    } catch (error) {
      throw new Error(`docker inspect returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const aliases = networks[externalNetwork]?.Aliases;
    if (Array.isArray(aliases) && aliases.some((value) => value === networkAlias)) return true;
  }
  return false;
}
