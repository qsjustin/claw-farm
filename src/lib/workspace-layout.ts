import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { RuntimeType } from "../runtimes/interface.ts";
import { getRuntime } from "../runtimes/index.ts";
import { dirExists } from "./fs-utils.ts";
import { buildRuntimeWorkspaceSlug } from "./bridge-response.ts";
import { validateName } from "./registry.ts";

export const WORKSPACE_LAYOUT_DIRS = [
  "config",
  "skills",
  "sessions",
  "runtime",
  "cache",
  "tmp",
] as const;

export type WorkspaceLayoutDir = typeof WORKSPACE_LAYOUT_DIRS[number];

export interface WorkspaceLayout {
  runtimeWorkspaceSlug: string;
  instanceRoot: string;
  runtimeRoot: string;
  workspaceRoot: string;
  configDir: string;
  skillsDir: string;
  sessionsDir: string;
  runtimeDataDir: string;
  cacheDir: string;
  tmpDir: string;
}

function directoryMap(layout: WorkspaceLayout): Record<WorkspaceLayoutDir, string> {
  return {
    config: layout.configDir,
    skills: layout.skillsDir,
    sessions: layout.sessionsDir,
    runtime: layout.runtimeDataDir,
    cache: layout.cacheDir,
    tmp: layout.tmpDir,
  };
}

export function resolveWorkspaceLayout(
  projectDir: string,
  userId: string,
  runtimeType: RuntimeType,
): WorkspaceLayout {
  const runtime = getRuntime(runtimeType);
  validateName(userId, "user ID");
  const instancesBase = resolve(projectDir, "instances");
  const instanceRoot = resolve(instancesBase, userId);
  if (!instanceRoot.startsWith(instancesBase + sep)) {
    throw new Error(`Invalid userId: path traversal detected ("${userId}")`);
  }
  const runtimeRoot = join(instanceRoot, runtime.runtimeDirName);
  const workspaceRoot = join(runtimeRoot, "workspace");

  return {
    runtimeWorkspaceSlug: buildRuntimeWorkspaceSlug(userId),
    instanceRoot,
    runtimeRoot,
    workspaceRoot,
    configDir: join(workspaceRoot, "config"),
    skillsDir: join(workspaceRoot, "skills"),
    sessionsDir: join(workspaceRoot, "sessions"),
    runtimeDataDir: join(workspaceRoot, "runtime"),
    cacheDir: join(workspaceRoot, "cache"),
    tmpDir: join(workspaceRoot, "tmp"),
  };
}

export async function ensureWorkspaceLayout(layout: WorkspaceLayout): Promise<WorkspaceLayout> {
  await mkdir(layout.workspaceRoot, { recursive: true, mode: 0o755 });
  await Promise.all(Object.values(directoryMap(layout)).map((dir) => mkdir(dir, { recursive: true, mode: 0o755 })));
  return layout;
}

export async function validateWorkspaceLayout(layout: WorkspaceLayout): Promise<{
  ok: boolean;
  missing: WorkspaceLayoutDir[];
}> {
  const missing: WorkspaceLayoutDir[] = [];

  for (const [dir, location] of Object.entries(directoryMap(layout)) as Array<[WorkspaceLayoutDir, string]>) {
    if (!await dirExists(location)) {
      missing.push(dir);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}
