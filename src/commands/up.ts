import { join } from "node:path";
import { resolveProjectName, loadRegistry, getInstance, findPositionalArg } from "../lib/registry.ts";
import { readProjectConfig, resolveRuntimeConfig } from "../lib/config.ts";
import { runCompose, sharedProxyConnect, COMPOSE_FILENAME } from "../lib/compose.ts";
import { snapshotWorkspace } from "../lib/raw-collector.ts";
import { instanceDir } from "../lib/instance.ts";
import { getRuntime, type RuntimeType, type ProxyMode } from "../runtimes/index.ts";

/** Start shared proxy compose if needed. */
async function ensureSharedProxy(
  projectDir: string,
  projectName: string,
  runtimeType: RuntimeType,
  proxyMode: ProxyMode,
): Promise<void> {
  if (proxyMode !== "shared" || runtimeType === "openclaw") return;
  const proxyComposePath = join(projectDir, "docker-compose.proxy.yml");
  if (!await Bun.file(proxyComposePath).exists()) {
    // Proxy compose not found — generate it
    const runtime = getRuntime(runtimeType);
    if (runtime.proxyComposeTemplate) {
      await Bun.write(proxyComposePath, runtime.proxyComposeTemplate(projectName));
    }
  }
  console.log(`\n▶ Starting shared api-proxy...`);
  await runCompose(projectDir, "up", {
    composePath: proxyComposePath,
    projectName: `${projectName}-proxy`,
  });
}

export async function upCommand(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const userIdx = args.indexOf("--user");
  const userId = userIdx !== -1 ? args[userIdx + 1] : undefined;

  if (all) {
    const reg = await loadRegistry();
    const names = Object.keys(reg.projects);
    if (names.length === 0) {
      console.log("No projects registered. Run: claw-farm init <name>");
      return;
    }
    for (const name of names) {
      const project = reg.projects[name];
      const config = await readProjectConfig(project.path);
      const { runtimeType, runtime, proxyMode } = resolveRuntimeConfig(config, project);

      if (project.multiInstance) {
        await ensureSharedProxy(project.path, name, runtimeType, proxyMode);
        const userIds = Object.keys(project.instances ?? {});
        await Promise.all(userIds.map(async (uid) => {
          console.log(`\n▶ Starting ${name}/${uid}...`);
          const instDir = instanceDir(project.path, uid);
          const composePath = join(instDir, COMPOSE_FILENAME);
          await runCompose(project.path, "up", {
            composePath,
            projectName: `${name}-${uid}`,
            connectContainer: sharedProxyConnect(name, uid, runtimeType, proxyMode),
          });
        }));
      } else {
        console.log(`\n▶ Starting ${name}...`);
        await runCompose(project.path, "up");
      }
    }
    console.log(`\n✅ All ${names.length} project(s) started.`);
    return;
  }

  const name = findPositionalArg(args);
  const { name: projectName, entry } = await resolveProjectName(name);
  const config = await readProjectConfig(entry.path);
  const { runtimeType, runtime, proxyMode } = resolveRuntimeConfig(config, entry);

  if (entry.multiInstance && userId) {
    // Start specific instance
    const instance = await getInstance(projectName, userId);
    if (!instance) throw new Error(`Instance "${userId}" not found in "${projectName}"`);

    await ensureSharedProxy(entry.path, projectName, runtimeType, proxyMode);

    const instDir = instanceDir(entry.path, userId);
    const composePath = join(instDir, COMPOSE_FILENAME);

    console.log(`\n▶ Starting ${projectName}/${userId}...`);
    await runCompose(entry.path, "up", {
      composePath,
      projectName: `${projectName}-${userId}`,
      connectContainer: sharedProxyConnect(projectName, userId, runtimeType, proxyMode),
    });
    console.log(`\n✅ ${projectName}/${userId} is running at http://localhost:${instance.port}`);
    return;
  }

  if (entry.multiInstance && !userId) {
    // Start all instances for this project
    const userIds = Object.keys(entry.instances ?? {});
    if (userIds.length === 0) {
      console.log(`No instances for "${projectName}". Run: claw-farm spawn ${projectName} --user <id>`);
      return;
    }

    await ensureSharedProxy(entry.path, projectName, runtimeType, proxyMode);

    await Promise.all(userIds.map(async (uid) => {
      console.log(`\n▶ Starting ${projectName}/${uid}...`);
      const instDir = instanceDir(entry.path, uid);
      const composePath = join(instDir, COMPOSE_FILENAME);
      await runCompose(entry.path, "up", {
        composePath,
        projectName: `${projectName}-${uid}`,
        connectContainer: sharedProxyConnect(projectName, uid, runtimeType, proxyMode),
      });
    }));
    console.log(`\n✅ All ${userIds.length} instance(s) of ${projectName} started.`);
    return;
  }

  // Single-instance mode
  try {
    await snapshotWorkspace(entry.path, runtimeType);
  } catch {
    // Not critical
  }

  console.log(`\n▶ Starting ${projectName}...`);
  await runCompose(entry.path, "up");
  console.log(`\n✅ ${projectName} is running at http://localhost:${entry.port}`);
}
