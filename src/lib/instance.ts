import { join, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import { validateName } from "./registry.ts";
import type { RuntimeType } from "../runtimes/interface.ts";

/**
 * Instance directory helpers for multi-instance projects.
 * Manages per-user instance directories under instances/<userId>/
 */

/** Resolve instance directory with path traversal protection. */
export function instanceDir(projectDir: string, userId: string): string {
  const instancesBase = resolve(projectDir, "instances");
  const resolved = resolve(instancesBase, userId);
  if (!resolved.startsWith(instancesBase + sep)) {
    throw new Error(`Invalid userId: path traversal detected ("${userId}")`);
  }
  return resolved;
}

export function templateDir(projectDir: string): string {
  return join(projectDir, "template");
}

/**
 * Create per-instance directory structure.
 * Directory layout differs by runtime:
 * - openclaw: openclaw/workspace/, openclaw/sessions/, openclaw/logs/
 * - picoclaw: picoclaw/workspace/, picoclaw/workspace/memory/, picoclaw/workspace/sessions/
 */
export async function ensureInstanceDirs(
  projectDir: string,
  userId: string,
  runtime?: RuntimeType,
): Promise<string> {
  validateName(userId, "user ID");
  const instDir = instanceDir(projectDir, userId);
  const rt = runtime ?? "openclaw";

  if (rt === "picoclaw") {
    // picoclaw workspace structure: sessions/ and memory/ are under workspace/
    await mkdir(join(instDir, "picoclaw", "workspace", "memory"), { recursive: true, mode: 0o755 });
    await mkdir(join(instDir, "picoclaw", "workspace", "sessions"), { recursive: true, mode: 0o755 });
    await mkdir(join(instDir, "picoclaw", "workspace", "state"), { recursive: true, mode: 0o755 });
    await mkdir(join(instDir, "picoclaw", "workspace", "skills"), { recursive: true, mode: 0o755 });
  } else {
    // OpenClaw workspace structure
    await mkdir(join(instDir, "openclaw", "workspace", "memory"), { recursive: true, mode: 0o755 });
    await mkdir(join(instDir, "openclaw", "sessions"), { recursive: true, mode: 0o755 });
    await mkdir(join(instDir, "openclaw", "logs"), { recursive: true, mode: 0o755 });
  }

  // API proxy logs directory (mounted as ./logs:/logs in api-proxy service)
  await mkdir(join(instDir, "logs"), { recursive: true, mode: 0o755 });
  // Memory pipeline directories (not in container)
  await mkdir(join(instDir, "raw", "workspace-snapshots"), { recursive: true, mode: 0o755 });
  await mkdir(join(instDir, "processed"), { recursive: true, mode: 0o755 });
  return instDir;
}

export async function ensureTemplateDirs(projectDir: string): Promise<void> {
  const tmplDir = templateDir(projectDir);
  await mkdir(join(tmplDir, "skills"), { recursive: true });
  await mkdir(join(tmplDir, "config"), { recursive: true });
}
