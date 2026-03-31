import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { resolveProjectName, findPositionalArg } from "../lib/registry.ts";
import { readProjectConfig } from "../lib/config.ts";
import { instanceDir } from "../lib/instance.ts";
import { builtinProcessor } from "../processors/builtin.ts";
import { mem0Processor } from "../processors/mem0.ts";
import type { RuntimeType } from "../runtimes/interface.ts";

export async function memoryRebuildCommand(args: string[]): Promise<void> {
  const userIdx = args.indexOf("--user");
  const userId = userIdx !== -1 ? args[userIdx + 1] : undefined;
  const name = findPositionalArg(args);
  const { name: projectName, entry } = await resolveProjectName(name);

  const config = await readProjectConfig(entry.path);
  const processor = config?.processor ?? entry.processor;
  const runtimeType: RuntimeType = config?.runtime ?? entry.runtime ?? "openclaw";

  if (entry.multiInstance && userId) {
    // Rebuild specific instance memory
    console.log(`\n🔄 Rebuilding memory for ${projectName}/${userId}...`);
    await rebuildInstanceMemory(entry.path, userId, processor, runtimeType);
    console.log(`\n✅ Memory rebuild complete for ${projectName}/${userId}.\n`);
    return;
  }

  if (entry.multiInstance && !userId) {
    // Rebuild all instance memories
    const instances = entry.instances ?? {};
    const userIds = Object.keys(instances);
    console.log(`\n🔄 Rebuilding memory for all ${userIds.length} instance(s) of ${projectName}...`);
    for (const uid of userIds) {
      console.log(`\n  → ${uid}`);
      await rebuildInstanceMemory(entry.path, uid, processor, runtimeType);
    }
    console.log(`\n✅ Memory rebuild complete for ${projectName}.\n`);
    return;
  }

  // Single-instance mode
  console.log(`\n🔄 Rebuilding memory for ${projectName}...`);

  if (processor === "mem0") {
    await mem0Processor.rebuild(entry.path);
  } else {
    await builtinProcessor.rebuild(entry.path);
  }

  console.log(`\n✅ Memory rebuild complete for ${projectName}.\n`);
}

async function rebuildInstanceMemory(
  projectDir: string,
  userId: string,
  processor: "builtin" | "mem0" = "builtin",
  runtimeType: RuntimeType = "openclaw",
): Promise<void> {
  const instDir = instanceDir(projectDir, userId);
  const rtDir = runtimeType === "picoclaw" ? "picoclaw" : "openclaw";

  // Determine session and memory paths based on runtime
  const sessionsDir = runtimeType === "picoclaw"
    ? join(instDir, rtDir, "workspace", "sessions")
    : join(instDir, rtDir, "sessions");
  const memoryPath = runtimeType === "picoclaw"
    ? join(instDir, rtDir, "workspace", "memory", "MEMORY.md")
    : join(instDir, rtDir, "workspace", "MEMORY.md");

  if (processor === "mem0") {
    // Re-index sessions from instance into Qdrant
    console.log("    Mem0 processor: re-indexing from instance sessions...");
    try {
      const files = await readdir(sessionsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      if (jsonlFiles.length === 0) {
        console.log("    No session logs found — nothing to rebuild");
        return;
      }
      console.log(`    Found ${jsonlFiles.length} session log(s) to process`);
      // TODO: Parse JSONL and POST to Mem0 /memories/add
      console.log("    (Full re-indexing not yet implemented — raw data preserved)");
    } catch {
      console.log("    Sessions directory not found — nothing to rebuild");
    }
    return;
  }

  // Builtin processor: rebuild MEMORY.md from latest snapshot
  const snapshotsDir = join(instDir, "raw", "workspace-snapshots");
  try {
    const snapshots = await readdir(snapshotsDir);
    if (snapshots.length === 0) {
      console.log("    No snapshots found — nothing to rebuild");
      return;
    }
    const latest = snapshots.sort().at(-1)!;
    const memoryContent = await Bun.file(join(snapshotsDir, latest, "MEMORY.md")).text();
    await Bun.write(memoryPath, memoryContent);
    console.log(`    Rebuilt MEMORY.md from snapshot: ${latest}`);
  } catch {
    console.log("    No snapshots available — skipping rebuild");
  }
}
