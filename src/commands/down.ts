import { join } from "node:path";
import { resolveProjectName, loadRegistry, getInstance, findPositionalArg } from "../lib/registry.ts";
import { readProjectConfig, resolveRuntimeConfig } from "../lib/config.ts";
import { runCompose, sharedProxyConnect, COMPOSE_FILENAME } from "../lib/compose.ts";
import { snapshotWorkspace } from "../lib/raw-collector.ts";
import { instanceDir } from "../lib/instance.ts";
import type { RuntimeType, ProxyMode } from "../runtimes/index.ts";

/** Stop shared proxy compose if no instances remain running. */
async function stopSharedProxy(
  projectDir: string,
  projectName: string,
  runtimeType: RuntimeType,
  proxyMode: ProxyMode,
): Promise<void> {
  if (proxyMode !== "shared" || runtimeType === "openclaw") return;
  const proxyComposePath = join(projectDir, "docker-compose.proxy.yml");
  if (!await Bun.file(proxyComposePath).exists()) {
    return; // No proxy compose file
  }
  console.log(`\n■ Stopping shared api-proxy...`);
  try {
    await runCompose(projectDir, "down", {
      composePath: proxyComposePath,
      projectName: `${projectName}-proxy`,
    });
  } catch {
    // Best effort
  }
}

export async function downCommand(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const userIdx = args.indexOf("--user");
  const userId = userIdx !== -1 ? args[userIdx + 1] : undefined;

  if (all) {
    const reg = await loadRegistry();
    const names = Object.keys(reg.projects);
    if (names.length === 0) {
      console.log("No projects registered.");
      return;
    }
    for (const name of names) {
      const project = reg.projects[name];
      const config = await readProjectConfig(project.path);
      const { runtimeType, proxyMode } = resolveRuntimeConfig(config, project);

      if (project.multiInstance) {
        const userIds = Object.keys(project.instances ?? {});
        await Promise.all(userIds.map(async (uid) => {
          console.log(`\n■ Stopping ${name}/${uid}...`);
          const instDir = instanceDir(project.path, uid);
          const composePath = join(instDir, COMPOSE_FILENAME);
          try {
            await runCompose(project.path, "down", {
              composePath,
              projectName: `${name}-${uid}`,
              connectContainer: sharedProxyConnect(name, uid, runtimeType, proxyMode),
            });
          } catch {}
        }));
        // Stop shared proxy after all instances
        await stopSharedProxy(project.path, name, runtimeType, proxyMode);
      } else {
        console.log(`\n■ Stopping ${name}...`);
        try {
          await snapshotWorkspace(project.path, runtimeType);
        } catch {}
        await runCompose(project.path, "down");
      }
    }
    console.log(`\n✅ All ${names.length} project(s) stopped.`);
    return;
  }

  const name = findPositionalArg(args);
  const { name: projectName, entry } = await resolveProjectName(name);
  const config = await readProjectConfig(entry.path);
  const { runtimeType, proxyMode } = resolveRuntimeConfig(config, entry);

  if (entry.multiInstance && userId) {
    const instance = await getInstance(projectName, userId);
    if (!instance) throw new Error(`Instance "${userId}" not found in "${projectName}"`);

    const instDir = instanceDir(entry.path, userId);
    const composePath = join(instDir, COMPOSE_FILENAME);

    console.log(`\n■ Stopping ${projectName}/${userId}...`);
    await runCompose(entry.path, "down", {
      composePath,
      projectName: `${projectName}-${userId}`,
      connectContainer: sharedProxyConnect(projectName, userId, runtimeType, proxyMode),
    });
    console.log(`\n✅ ${projectName}/${userId} stopped.`);
    return;
  }

  if (entry.multiInstance && !userId) {
    const userIds = Object.keys(entry.instances ?? {});
    if (userIds.length === 0) {
      console.log(`No instances for "${projectName}".`);
      return;
    }
    await Promise.all(userIds.map(async (uid) => {
      console.log(`\n■ Stopping ${projectName}/${uid}...`);
      const instDir = instanceDir(entry.path, uid);
      const composePath = join(instDir, COMPOSE_FILENAME);
      try {
        await runCompose(entry.path, "down", {
          composePath,
          projectName: `${projectName}-${uid}`,
          connectContainer: sharedProxyConnect(projectName, uid, runtimeType, proxyMode),
        });
      } catch {}
    }));
    // Stop shared proxy after all instances are down
    await stopSharedProxy(entry.path, projectName, runtimeType, proxyMode);
    console.log(`\n✅ All ${userIds.length} instance(s) of ${projectName} stopped.`);
    return;
  }

  // Single-instance mode
  try {
    await snapshotWorkspace(entry.path, runtimeType);
    console.log("✓ Workspace snapshot saved");
  } catch {}

  console.log(`\n■ Stopping ${projectName}...`);
  await runCompose(entry.path, "down");
  console.log(`\n✅ ${projectName} stopped.`);
}
