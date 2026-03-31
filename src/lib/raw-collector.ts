import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { RuntimeType } from "../runtimes/interface.ts";

/**
 * Layer 0: Raw data collection — immutable, append-only.
 * Session logs and workspace snapshots are preserved here and never deleted.
 */

export async function ensureRawDirs(
  projectDir: string,
  runtimeType?: RuntimeType,
): Promise<void> {
  const rt = runtimeType ?? "openclaw";
  if (rt === "picoclaw") {
    // picoclaw stores sessions under workspace/
    await mkdir(join(projectDir, "picoclaw", "workspace", "sessions"), { recursive: true });
  } else {
    await mkdir(join(projectDir, "openclaw", "sessions"), { recursive: true });
    await mkdir(join(projectDir, "openclaw", "logs"), { recursive: true });
  }
  await mkdir(join(projectDir, "raw", "workspace-snapshots"), { recursive: true });
}

export async function snapshotWorkspace(
  projectDir: string,
  runtimeType?: RuntimeType,
): Promise<string> {
  const rt = runtimeType ?? "openclaw";
  const wsDir = rt === "picoclaw"
    ? join(projectDir, "picoclaw", "workspace")
    : join(projectDir, "openclaw", "workspace");
  const snapDir = join(projectDir, "raw", "workspace-snapshots");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapPath = join(snapDir, timestamp);

  await mkdir(snapPath, { recursive: true });

  // Snapshot MEMORY.md and SOUL.md
  const memoryFile = rt === "picoclaw" ? join(wsDir, "memory", "MEMORY.md") : join(wsDir, "MEMORY.md");
  for (const { src, dest } of [
    { src: memoryFile, dest: "MEMORY.md" },
    { src: join(wsDir, "SOUL.md"), dest: "SOUL.md" },
  ]) {
    try {
      const content = await Bun.file(src).text();
      await Bun.write(join(snapPath, dest), content);
    } catch {
      // File doesn't exist yet — skip
    }
  }

  return snapPath;
}
