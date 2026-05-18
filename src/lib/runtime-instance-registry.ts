import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, unlink, writeFile, readFile, stat } from "node:fs/promises";
import type { RuntimeType } from "../runtimes/interface.ts";
import { getRuntime } from "../runtimes/index.ts";
import { validateName } from "./registry.ts";

const REGISTRY_DIR = join(homedir(), ".claw-farm");
const RUNTIME_REGISTRY_PATH = join(REGISTRY_DIR, "runtime-instances.json");
const RUNTIME_LOCK_PATH = join(REGISTRY_DIR, "runtime-instances.lock");

export type RuntimeInstanceStatus =
  | "provisioning"
  | "starting"
  | "running"
  | "unhealthy"
  | "stopped"
  | "deleting"
  | "deleted"
  | "migrating"
  | "error";

export interface RuntimeHealthSnapshot {
  observedAt: string | null;
  ready: boolean;
  version?: string;
  capabilities?: string[];
  lastError?: string;
}

export interface RuntimeInstanceRegistryEntry {
  runtimeInstanceKey: string;
  runtimeType: RuntimeType;
  project: string;
  userId: string;
  displayName?: string;
  status: RuntimeInstanceStatus;
  composeProject: string;
  containerName: string;
  networkName?: string;
  internalPort: number;
  hostPort: number | null;
  endpointRef: string;
  apiKeyRef?: string;
  profileRef?: string;
  dataVolumeRef: string;
  workspaceRef: string;
  health: RuntimeHealthSnapshot;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface RuntimeEndpointResolution {
  endpointRef: string;
  baseUrl: string;
  exposure: "internal-docker";
}

export interface RuntimeInstanceRegistry {
  version: 1;
  instances: Record<string, RuntimeInstanceRegistryEntry>;
}

export interface RuntimeInstanceUpsertInput {
  project: string;
  userId: string;
  runtimeType: RuntimeType;
  status: RuntimeInstanceStatus;
  hostPort: number | null;
  displayName?: string;
  apiKeyRef?: string;
  profileRef?: string;
  health?: Partial<RuntimeHealthSnapshot>;
}

function defaultRuntimeRegistry(): RuntimeInstanceRegistry {
  return { version: 1, instances: {} };
}

let _runtimeLockChain: Promise<void> = Promise.resolve();

async function acquireRuntimeLock(): Promise<void> {
  await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 });

  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await writeFile(RUNTIME_LOCK_PATH, String(process.pid), { flag: "wx", mode: 0o600 });
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const lockStat = await stat(RUNTIME_LOCK_PATH);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          const pid = parseInt((await readFile(RUNTIME_LOCK_PATH, "utf8")).trim(), 10);
          try {
            process.kill(pid, 0);
          } catch {
            await unlink(RUNTIME_LOCK_PATH);
            continue;
          }
        }
      } catch {
        // Lock vanished or could not be inspected; retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 50));
    }
  }
  throw new Error("Could not acquire runtime instance registry lock after 5 seconds.");
}

async function releaseRuntimeLock(): Promise<void> {
  try {
    await unlink(RUNTIME_LOCK_PATH);
  } catch {
    // Already released.
  }
}

export function withRuntimeInstanceRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = _runtimeLockChain.then(async () => {
    await acquireRuntimeLock();
    try {
      return await fn();
    } finally {
      await releaseRuntimeLock();
    }
  });
  _runtimeLockChain = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function runtimeInstanceKey(project: string, userId: string): string {
  validateName(project, "project name");
  validateName(userId, "user ID");
  return `${project}:${userId}`;
}

export async function loadRuntimeInstanceRegistry(): Promise<RuntimeInstanceRegistry> {
  try {
    const raw = await Bun.file(RUNTIME_REGISTRY_PATH).text();
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !parsed.instances || typeof parsed.instances !== "object") {
      return defaultRuntimeRegistry();
    }
    return parsed as RuntimeInstanceRegistry;
  } catch {
    return defaultRuntimeRegistry();
  }
}

export async function saveRuntimeInstanceRegistry(
  registry: RuntimeInstanceRegistry,
): Promise<void> {
  await mkdir(dirname(RUNTIME_REGISTRY_PATH), { recursive: true, mode: 0o700 });
  await Bun.write(RUNTIME_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
  await chmod(RUNTIME_REGISTRY_PATH, 0o600);
}

function containerName(project: string, userId: string, runtimeType: RuntimeType): string {
  const runtime = getRuntime(runtimeType);
  return `${project}-${userId}-${runtime.runtimeDirName}`;
}

function defaultHealth(
  status: RuntimeInstanceStatus,
  health?: Partial<RuntimeHealthSnapshot>,
): RuntimeHealthSnapshot {
  return {
    observedAt: new Date().toISOString(),
    ready: status === "running",
    ...health,
  };
}

export function buildRuntimeInstanceEntry(
  input: RuntimeInstanceUpsertInput,
  existing?: RuntimeInstanceRegistryEntry,
): RuntimeInstanceRegistryEntry {
  const key = runtimeInstanceKey(input.project, input.userId);
  const runtime = getRuntime(input.runtimeType);
  const now = new Date().toISOString();
  return {
    runtimeInstanceKey: key,
    runtimeType: input.runtimeType,
    project: input.project,
    userId: input.userId,
    displayName: input.displayName ?? existing?.displayName,
    status: input.status,
    composeProject: `${input.project}-${input.userId}`,
    containerName: containerName(input.project, input.userId, input.runtimeType),
    networkName: `${input.project}-${input.userId}_default`,
    internalPort: runtime.gatewayPort,
    hostPort: input.hostPort,
    endpointRef: `claw-farm:${key}:endpoint`,
    apiKeyRef: input.apiKeyRef ?? existing?.apiKeyRef,
    profileRef: input.profileRef ?? existing?.profileRef,
    dataVolumeRef: `claw-farm:${key}:data:${runtime.runtimeDirName}`,
    workspaceRef: `claw-farm:${key}:workspace`,
    health: defaultHealth(input.status, input.health),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: input.status === "deleted" ? now : null,
  };
}

export async function upsertRuntimeInstance(
  input: RuntimeInstanceUpsertInput,
): Promise<RuntimeInstanceRegistryEntry> {
  return withRuntimeInstanceRegistryLock(async () => {
    const registry = await loadRuntimeInstanceRegistry();
    const key = runtimeInstanceKey(input.project, input.userId);
    const entry = buildRuntimeInstanceEntry(input, registry.instances[key]);
    registry.instances[key] = entry;
    await saveRuntimeInstanceRegistry(registry);
    return entry;
  });
}

export async function updateRuntimeInstanceStatus(
  project: string,
  userId: string,
  status: RuntimeInstanceStatus,
  health?: Partial<RuntimeHealthSnapshot>,
): Promise<RuntimeInstanceRegistryEntry | null> {
  return withRuntimeInstanceRegistryLock(async () => {
    const registry = await loadRuntimeInstanceRegistry();
    const key = runtimeInstanceKey(project, userId);
    const existing = registry.instances[key];
    if (!existing) return null;
    const entry = buildRuntimeInstanceEntry({
      project,
      userId,
      runtimeType: existing.runtimeType,
      status,
      hostPort: existing.hostPort,
      displayName: existing.displayName,
      apiKeyRef: existing.apiKeyRef,
      profileRef: existing.profileRef,
      health,
    }, existing);
    registry.instances[key] = entry;
    await saveRuntimeInstanceRegistry(registry);
    return entry;
  });
}

export async function removeRuntimeInstance(
  project: string,
  userId: string,
): Promise<RuntimeInstanceRegistryEntry | null> {
  return withRuntimeInstanceRegistryLock(async () => {
    const registry = await loadRuntimeInstanceRegistry();
    const key = runtimeInstanceKey(project, userId);
    const existing = registry.instances[key] ?? null;
    if (!existing) return null;
    delete registry.instances[key];
    await saveRuntimeInstanceRegistry(registry);
    return existing;
  });
}

export async function getRuntimeInstance(
  project: string,
  userId: string,
): Promise<RuntimeInstanceRegistryEntry | null> {
  const registry = await loadRuntimeInstanceRegistry();
  return registry.instances[runtimeInstanceKey(project, userId)] ?? null;
}

export async function listRuntimeInstances(filter?: {
  project?: string;
  runtimeType?: RuntimeType;
  status?: RuntimeInstanceStatus;
}): Promise<RuntimeInstanceRegistryEntry[]> {
  const registry = await loadRuntimeInstanceRegistry();
  return Object.values(registry.instances).filter((entry) => {
    if (filter?.project && entry.project !== filter.project) return false;
    if (filter?.runtimeType && entry.runtimeType !== filter.runtimeType) return false;
    if (filter?.status && entry.status !== filter.status) return false;
    return true;
  });
}

export function redactedRuntimeInstance(
  entry: RuntimeInstanceRegistryEntry,
): RuntimeInstanceRegistryEntry {
  return {
    ...entry,
    apiKeyRef: entry.apiKeyRef ? "ref:***" : undefined,
    profileRef: entry.profileRef ? "ref:***" : undefined,
  };
}

export function resolveRuntimeInternalEndpoint(
  entry: RuntimeInstanceRegistryEntry,
): RuntimeEndpointResolution {
  return {
    endpointRef: entry.endpointRef,
    baseUrl: `http://${entry.containerName}:${entry.internalPort}`,
    exposure: "internal-docker",
  };
}
