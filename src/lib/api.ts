/**
 * Programmatic API for claw-farm.
 * Import from "@permissionlabs/claw-farm" to spawn/despawn instances from code.
 *
 * Both CLI commands and external callers use these functions.
 */

import { join } from "node:path";
import { mkdir, readdir, cp } from "node:fs/promises";
import {
  resolveProjectName,
  addInstance,
  removeInstance,
  listInstances as registryListInstances,
  getInstance,
  validateName,
  type InstanceEntry,
} from "./registry.ts";
import { readProjectConfig } from "./config.ts";
import { ensureInstanceDirs, instanceDir, templateDir } from "./instance.ts";
import { instanceComposeTemplate } from "../templates/docker-compose.instance.yml.ts";
import { fillUserTemplate } from "../templates/USER.template.md.ts";
import { runCompose } from "./compose.ts";
import { migrateToMulti } from "./migrate.ts";
import { getRuntime } from "../runtimes/index.ts";
import type { RuntimeType, ProxyMode } from "../runtimes/interface.ts";

export type { InstanceEntry };

export async function spawn(options: {
  project: string;
  userId: string;
  context?: Record<string, string>;
  autoStart?: boolean;
}): Promise<{ userId: string; port: number }> {
  const { project, userId, context, autoStart = true } = options;

  // Validate userId (security: prevents path traversal via programmatic API)
  validateName(userId, "user ID");

  const { name: projectName, entry } = await resolveProjectName(project);
  const projectDir = entry.path;
  const config = await readProjectConfig(projectDir);

  // Determine runtime
  const runtimeType: RuntimeType = config?.runtime ?? entry.runtime ?? "openclaw";
  const runtime = getRuntime(runtimeType);
  const proxyMode: ProxyMode = config?.proxyMode ?? runtime.defaultProxyMode;

  // Auto-migrate if needed
  if (!entry.multiInstance && !config?.multiInstance) {
    await migrateToMulti(projectName, projectDir);
  }

  // Register instance (validates userId again, acquires lock)
  const { port } = await addInstance(projectName, userId);

  // From here, if anything fails, we must roll back the registry entry
  try {
    // Create instance dirs (runtime-aware)
    const instDir = await ensureInstanceDirs(projectDir, userId, runtimeType);
    const rtDir = runtime.runtimeDirName;

    // Copy config files from template to instance
    const tmplDir = templateDir(projectDir);

    // Copy main config file
    const configSrc = join(tmplDir, "config", runtime.configFileName);
    const configDest = join(instDir, rtDir, runtime.configFileName);
    const configFile = Bun.file(configSrc);
    if (await configFile.exists()) {
      await Bun.write(configDest, await configFile.arrayBuffer());
    }

    // Copy additional config files (e.g., policy.yaml for openclaw)
    for (const additionalFile of runtime.additionalConfigFiles) {
      const src = join(tmplDir, "config", additionalFile);
      const dest = join(instDir, rtDir, additionalFile);
      const file = Bun.file(src);
      if (await file.exists()) {
        await Bun.write(dest, await file.arrayBuffer());
      }
    }

    // Copy shared template files (SOUL.md, AGENTS.md, skills/) into instance workspace
    const workspaceDir = join(instDir, rtDir, "workspace");
    await copyTemplateFiles(tmplDir, workspaceDir);

    // Fill USER.md — only write if file doesn't already exist (preserve on re-spawn with --keep-data)
    const userPath = join(instDir, rtDir, "workspace", "USER.md");
    if (!await fileExists(userPath)) {
      let userContent: string;
      try {
        const template = await Bun.file(join(tmplDir, "USER.template.md")).text();
        userContent = fillUserTemplate(template, userId, context);
      } catch {
        userContent = `# ${projectName} — User Profile\n\n- User ID: ${userId}\n`;
        if (context && Object.keys(context).length > 0) {
          userContent += "\n## Details\n";
          for (const [k, v] of Object.entries(context)) {
            userContent += `- ${k}: ${v}\n`;
          }
        }
      }
      await Bun.write(userPath, userContent);
    }

    // Initial MEMORY.md — only write if file doesn't already exist
    // picoclaw uses workspace/memory/MEMORY.md, openclaw uses workspace/MEMORY.md
    const memoryPath = runtimeType === "picoclaw"
      ? join(instDir, rtDir, "workspace", "memory", "MEMORY.md")
      : join(instDir, rtDir, "workspace", "MEMORY.md");
    if (!await fileExists(memoryPath)) {
      await Bun.write(
        memoryPath,
        `# ${projectName} — Memory (${userId})\n\n> This file is updated automatically as the agent learns from conversations.\n`,
      );
    }

    // Write compose (always regenerate)
    let composeContent: string;
    if (runtimeType === "openclaw") {
      composeContent = instanceComposeTemplate(projectName, userId, port, proxyMode);
    } else {
      composeContent = runtime.instanceComposeTemplate(projectName, userId, port, proxyMode);
    }
    const composePath = join(instDir, "docker-compose.openclaw.yml");
    await Bun.write(composePath, composeContent);

    // Start if requested
    if (autoStart) {
      // Ensure shared proxy is running (generates compose if needed, starts it)
      if (proxyMode === "shared" && runtimeType !== "openclaw") {
        const proxyComposePath = join(projectDir, "docker-compose.proxy.yml");
        try {
          await Bun.file(proxyComposePath).text();
        } catch {
          // Generate proxy compose if missing
          if (runtime.proxyComposeTemplate) {
            await Bun.write(proxyComposePath, runtime.proxyComposeTemplate(projectName));
          }
        }
        await runCompose(projectDir, "up", {
          composePath: proxyComposePath,
          projectName: `${projectName}-proxy`,
        });
      }

      // For shared proxy mode: after compose up, connect the shared api-proxy
      // container to this instance's isolated network (hub-and-spoke topology).
      // Docker Compose v2 names networks as: {project}_{network}
      const composeProject = `${projectName}-${userId}`;
      const connectContainer = (proxyMode === "shared" && runtimeType !== "openclaw")
        ? { container: `${projectName}-api-proxy`, network: `${composeProject}_instance-net` }
        : undefined;

      await runCompose(projectDir, "up", {
        composePath,
        projectName: composeProject,
        connectContainer,
      });
    }

    return { userId, port };
  } catch (err) {
    // Rollback: remove from registry on failure
    try {
      await removeInstance(projectName, userId);
    } catch {
      // Best effort rollback
    }
    throw err;
  }
}

export async function despawn(
  project: string,
  userId: string,
  options?: { keepData?: boolean },
): Promise<void> {
  validateName(userId, "user ID");

  const { name: projectName, entry } = await resolveProjectName(project);
  const projectDir = entry.path;

  const instance = await getInstance(projectName, userId);
  if (!instance) {
    throw new Error(`Instance for user "${userId}" not found in "${projectName}"`);
  }

  // Stop containers first
  const instDir = instanceDir(projectDir, userId);
  const composePath = join(instDir, "docker-compose.openclaw.yml");

  // Determine if shared proxy mode — need to disconnect api-proxy from instance network
  const config = await readProjectConfig(projectDir);
  const runtimeType: RuntimeType = config?.runtime ?? entry.runtime ?? "openclaw";
  const runtime = getRuntime(runtimeType);
  const proxyMode: ProxyMode = config?.proxyMode ?? runtime.defaultProxyMode;
  const composeProject = `${projectName}-${userId}`;
  const connectContainer = (proxyMode === "shared" && runtimeType !== "openclaw")
    ? { container: `${projectName}-api-proxy`, network: `${composeProject}_instance-net` }
    : undefined;

  try {
    await runCompose(projectDir, "down", {
      composePath,
      projectName: composeProject,
      connectContainer,
    });
  } catch (err) {
    console.warn(`⚠ Could not stop containers: ${(err as Error).message}`);
  }

  // Remove data before registry (if data removal fails, registry still has the entry for retry)
  if (!options?.keepData) {
    const { rm } = await import("node:fs/promises");
    await rm(instDir, { recursive: true, force: true });
  }

  // Remove from registry last (after cleanup is done)
  await removeInstance(projectName, userId);
}

export async function listInstances(
  project: string,
): Promise<InstanceEntry[]> {
  const { name: projectName } = await resolveProjectName(project);
  return registryListInstances(projectName);
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/**
 * Copy shared template files (SOUL.md, AGENTS.md, skills/) into instance workspace.
 * Always overwrites — template changes should propagate to all instances.
 */
export async function copyTemplateFiles(
  tmplDir: string,
  workspaceDir: string,
  sharedFiles: string[] = ["SOUL.md", "AGENTS.md"],
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  // Copy individual shared files
  for (const file of sharedFiles) {
    const src = Bun.file(join(tmplDir, file));
    if (await src.exists()) {
      await Bun.write(join(workspaceDir, file), await src.arrayBuffer());
    }
  }
  // Copy skills/ directory
  const skillsSrc = join(tmplDir, "skills");
  const skillsDest = join(workspaceDir, "skills");
  try {
    const files = await readdir(skillsSrc);
    await mkdir(skillsDest, { recursive: true });
    for (const file of files) {
      await cp(join(skillsSrc, file), join(skillsDest, file), { recursive: true });
    }
  } catch {
    // No skills directory in template
  }
}
