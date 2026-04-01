import { join } from "node:path";
import { resolveProjectName, listInstances as listRegistryInstances, findPositionalArg } from "../lib/registry.ts";
import { instanceDir } from "../lib/instance.ts";
import { getComposeStatus, COMPOSE_FILENAME } from "../lib/compose.ts";

export async function instancesCommand(args: string[]): Promise<void> {
  const projectArg = findPositionalArg(args);
  const { name: projectName, entry } = await resolveProjectName(projectArg);

  if (!entry.multiInstance) {
    console.log(`\n"${projectName}" is a single-instance project. Use: claw-farm spawn ${projectName} --user <id> to enable multi-instance.\n`);
    return;
  }

  const instances = await listRegistryInstances(projectName);

  if (instances.length === 0) {
    console.log(`\nNo instances for "${projectName}". Run: claw-farm spawn ${projectName} --user <id>\n`);
    return;
  }

  console.log(`\n┌───────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${projectName} — instances                                     │`);
  console.log(`├──────────────────┬─────────┬───────────┬──────────────────────┤`);
  console.log(`│ User ID          │ Port    │ Status    │ Created              │`);
  console.log(`├──────────────────┼─────────┼───────────┼──────────────────────┤`);

  const rows = await Promise.all(instances.map(async (inst) => {
    const instDir_ = instanceDir(entry.path, inst.userId);
    const composePath = join(instDir_, COMPOSE_FILENAME);
    let status: string;
    try {
      status = await getComposeStatus(entry.path, {
        composePath,
        projectName: `${projectName}-${inst.userId}`,
      });
    } catch {
      status = "unknown";
    }
    return { inst, status };
  }));

  for (const { inst, status } of rows) {
    const statusIcon = status === "running" ? "🟢" : status === "stopped" ? "⚪" : "❓";

    const userCol = inst.userId.padEnd(16).slice(0, 16);
    const portCol = String(inst.port).padEnd(7);
    const statusCol = `${statusIcon} ${status}`.padEnd(9);
    const dateCol = inst.createdAt.slice(0, 19).padEnd(20);

    console.log(`│ ${userCol} │ ${portCol} │ ${statusCol} │ ${dateCol} │`);
  }

  console.log(`└──────────────────┴─────────┴───────────┴──────────────────────┘`);
  console.log(`\n  Total: ${instances.length} instance(s)\n`);
}
