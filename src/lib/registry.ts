import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeType } from "../runtimes/interface.ts";

const REGISTRY_DIR = join(homedir(), ".claw-farm");
const REGISTRY_PATH = join(REGISTRY_DIR, "registry.json");
const LOCK_PATH = join(REGISTRY_DIR, "registry.lock");

/** Validates userId/projectName for filesystem and Docker safety */
export const SAFE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Flags that consume the next arg as their value. */
const FLAGS_WITH_VALUES = new Set(["--processor", "--llm", "--user", "--context", "--runtime", "--proxy-mode", "--to"]);

/** Find first positional arg, skipping flags and their values. */
export function findPositionalArg(args: string[], exclude?: string[]): string | undefined {
  const excludeSet = exclude ? new Set(exclude) : undefined;
  for (let i = 0; i < args.length; i++) {
    if (FLAGS_WITH_VALUES.has(args[i])) { i++; continue; }
    if (args[i].startsWith("-")) continue;
    if (excludeSet?.has(args[i])) continue;
    return args[i];
  }
  return undefined;
}

export function validateName(value: string, label: string): void {
  if (!SAFE_NAME_REGEX.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}". Use lowercase letters, numbers, hyphens, and underscores (max 63 chars).`,
    );
  }
}

export interface InstanceEntry {
  userId: string;
  port: number;
  createdAt: string;
}

export interface ProjectEntry {
  path: string;
  port: number;
  processor: "builtin" | "mem0";
  createdAt: string;
  multiInstance?: boolean;
  runtime?: RuntimeType;
  instances?: Record<string, InstanceEntry>;
}

export interface Registry {
  projects: Record<string, ProjectEntry>;
  nextPort: number;
}

const DEFAULT_START_PORT = 18789;
const MAX_PORT = 65535;

function defaultRegistry(): Registry {
  return { projects: {}, nextPort: DEFAULT_START_PORT };
}

/**
 * Acquire a file lock for registry mutations.
 * Uses O_EXCL to atomically create a lock file.
 * Retries with backoff for up to ~5 seconds.
 */
async function acquireLock(): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 });

  const maxAttempts = 50;
  const baseDelay = 100; // ms

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await writeFile(LOCK_PATH, String(process.pid), { flag: "wx", mode: 0o600 });
      return; // Lock acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Check if lock is stale (older than 30s)
      try {
        const { stat } = await import("node:fs/promises");
        const lockStat = await stat(LOCK_PATH);
        const ageMs = Date.now() - lockStat.mtimeMs;
        if (ageMs > 30_000) {
          const { unlink } = await import("node:fs/promises");
          await unlink(LOCK_PATH);
          continue; // Retry immediately after removing stale lock
        }
      } catch {
        // Lock file disappeared between check and stat — retry
      }

      await new Promise((r) => setTimeout(r, baseDelay + Math.random() * 50));
    }
  }
  throw new Error("Could not acquire registry lock after 5 seconds. Is another claw-farm process running?");
}

async function releaseLock(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(LOCK_PATH);
  } catch {
    // Lock already released — fine
  }
}

/**
 * Run a callback with exclusive registry lock.
 * Ensures lock is always released, even on error.
 */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

export async function loadRegistry(): Promise<Registry> {
  try {
    const raw = await Bun.file(REGISTRY_PATH).text();
    const parsed = JSON.parse(raw);
    // Basic schema validation
    if (typeof parsed !== "object" || !parsed.projects || typeof parsed.nextPort !== "number") {
      console.warn("⚠ Registry file has unexpected format, using defaults");
      return defaultRegistry();
    }
    return parsed as Registry;
  } catch (err: unknown) {
    // Distinguish "file not found" from "corrupt JSON"
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as Error).message?.includes("No such file")) {
      return defaultRegistry();
    }
    if (err instanceof SyntaxError) {
      console.warn("⚠ Registry file is corrupted JSON, creating backup and using defaults");
      try {
        const { copyFile } = await import("node:fs/promises");
        await copyFile(REGISTRY_PATH, REGISTRY_PATH + ".corrupted." + Date.now());
      } catch { /* best effort */ }
      return defaultRegistry();
    }
    return defaultRegistry();
  }
}

export async function saveRegistry(reg: Registry): Promise<void> {
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(REGISTRY_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
  await chmod(REGISTRY_PATH, 0o600);
}

function allocatePort(reg: Registry): number {
  const usedPorts = new Set<number>();

  // Collect all ports in use
  for (const project of Object.values(reg.projects)) {
    usedPorts.add(project.port);
    if (project.instances) {
      for (const inst of Object.values(project.instances)) {
        usedPorts.add(inst.port);
      }
    }
  }

  // Find next available port starting from nextPort
  let port = reg.nextPort;
  while (usedPorts.has(port)) {
    port++;
  }

  if (port > MAX_PORT) {
    throw new Error(`Port exhaustion: no available ports below ${MAX_PORT}. Despawn unused instances to free ports.`);
  }

  // Update nextPort to one beyond the allocated port
  reg.nextPort = port + 1;
  if (reg.nextPort > MAX_PORT) {
    // Reset to scan from beginning next time
    reg.nextPort = DEFAULT_START_PORT;
  }

  return port;
}

export async function addProject(
  name: string,
  path: string,
  processor: "builtin" | "mem0",
  runtime?: RuntimeType,
): Promise<ProjectEntry> {
  validateName(name, "project name");

  return withLock(async () => {
    const reg = await loadRegistry();
    if (reg.projects[name]) {
      throw new Error(`Project "${name}" already exists in registry`);
    }
    const port = allocatePort(reg);
    const entry: ProjectEntry = {
      path,
      port,
      processor,
      createdAt: new Date().toISOString(),
      ...(runtime && runtime !== "openclaw" ? { runtime } : {}),
    };
    reg.projects[name] = entry;
    await saveRegistry(reg);
    return entry;
  });
}

export async function getProject(name: string): Promise<ProjectEntry | null> {
  const reg = await loadRegistry();
  return reg.projects[name] ?? null;
}

export async function addInstance(
  projectName: string,
  userId: string,
): Promise<{ port: number }> {
  validateName(userId, "user ID");

  return withLock(async () => {
    const reg = await loadRegistry();
    const project = reg.projects[projectName];
    if (!project) throw new Error(`Project "${projectName}" not found in registry`);
    if (!project.multiInstance) throw new Error(`Project "${projectName}" is not multi-instance`);

    if (!project.instances) project.instances = {};
    if (project.instances[userId]) {
      throw new Error(`Instance for user "${userId}" already exists in "${projectName}"`);
    }

    const port = allocatePort(reg);
    project.instances[userId] = {
      userId,
      port,
      createdAt: new Date().toISOString(),
    };
    await saveRegistry(reg);
    return { port };
  });
}

export async function removeInstance(
  projectName: string,
  userId: string,
): Promise<void> {
  return withLock(async () => {
    const reg = await loadRegistry();
    const project = reg.projects[projectName];
    if (!project) throw new Error(`Project "${projectName}" not found in registry`);
    if (!project.instances?.[userId]) {
      throw new Error(`Instance for user "${userId}" not found in "${projectName}"`);
    }
    delete project.instances[userId];
    await saveRegistry(reg);
  });
}

export async function getInstance(
  projectName: string,
  userId: string,
): Promise<InstanceEntry | null> {
  const reg = await loadRegistry();
  const project = reg.projects[projectName];
  if (!project) return null;
  return project.instances?.[userId] ?? null;
}

export async function listInstances(
  projectName: string,
): Promise<InstanceEntry[]> {
  const reg = await loadRegistry();
  const project = reg.projects[projectName];
  if (!project) throw new Error(`Project "${projectName}" not found in registry`);
  if (!project.instances) return [];
  return Object.values(project.instances);
}

export async function resolveProjectName(nameOrNull: string | undefined): Promise<{
  name: string;
  entry: ProjectEntry;
}> {
  if (nameOrNull) {
    const entry = await getProject(nameOrNull);
    if (!entry) throw new Error(`Project "${nameOrNull}" not found in registry`);
    return { name: nameOrNull, entry };
  }
  // Try to find by current directory
  const cwd = process.cwd();
  const reg = await loadRegistry();
  for (const [name, entry] of Object.entries(reg.projects)) {
    if (entry.path === cwd) return { name, entry };
  }
  throw new Error("No project name given and current directory is not a registered project");
}
