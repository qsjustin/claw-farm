/**
 * Programmatic API for claw-farm.
 * Import from "@permissionlabs/claw-farm" to spawn/despawn instances from code.
 *
 * Both CLI commands and external callers use these functions.
 */

import { join } from "node:path";
import { mkdir, readdir, cp, rm } from "node:fs/promises";
import {
  resolveProjectName,
  addInstance,
  removeInstance,
  listInstances as registryListInstances,
  getInstance,
  getProject,
  validateName,
  type InstanceEntry,
  type ProjectEntry,
} from "./registry.ts";
import {
  readProjectConfig,
  resolveRuntimeConfig,
  renderInstanceModelEnv,
  type InstanceModelEnvInput,
  type LlmProvider,
} from "./config.ts";
import { fileExists } from "./fs-utils.ts";
import { ensureInstanceDirs, instanceDir, templateDir } from "./instance.ts";
import { resolveWorkspaceLayout } from "./workspace-layout.ts";
import { instanceComposeTemplate } from "../templates/docker-compose.instance.yml.ts";
import { fillUserTemplate } from "../templates/USER.template.md.ts";
import {
  getComposeStatus,
  runCompose,
  sharedProxyConnect,
  COMPOSE_FILENAME,
} from "./compose.ts";
import { migrateToMulti } from "./migrate.ts";
import { getRuntime } from "../runtimes/index.ts";
import type { RuntimeType, ProxyMode } from "../runtimes/interface.ts";

export type { InstanceEntry, ProjectEntry };
export type { LlmProvider };
export { getInstance, getProject };

export type InstanceRuntimeState = "running" | "stopped" | "unknown";

export interface InstanceRuntimeStatus {
  status: InstanceRuntimeState;
  composePath: string;
  composeProject: string;
}

export interface ApplyInstanceModelControlOptions {
  project: string;
  userId: string;
  llm: LlmProvider;
  apiKey: string;
  modelSlug?: string;
  baseUrl?: string | null;
}

export interface ManagedInstanceControlOptions {
  quiet?: boolean;
}

const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateEnvEntry(key: string, value: string): string {
  if (!ENV_KEY_REGEX.test(key)) {
    throw new Error(`Invalid env var key: "${key}"`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`Env var "${key}" contains newline characters`);
  }
  return `${key}=${value}`;
}

async function resolveInstance(project: string, userId: string) {
  validateName(userId, "user ID");
  const { name: projectName, entry } = await resolveProjectName(project);
  const projectDir = entry.path;
  const instance = await getInstance(projectName, userId);
  if (!instance) {
    throw new Error(`Instance for user "${userId}" not found in "${projectName}"`);
  }
  const instDir = instanceDir(projectDir, userId);
  return {
    projectName, projectDir, entry, instance, instDir,
    composePath: join(instDir, COMPOSE_FILENAME),
    composeProject: `${projectName}-${userId}`,
  };
}

async function writeInstanceModelEnv(
  instDir: string,
  input: InstanceModelEnvInput,
): Promise<void> {
  await Bun.write(join(instDir, ".env.model"), renderInstanceModelEnv(input));
}

async function ensureSharedProxy(
  projectDir: string,
  projectName: string,
  runtimeType: RuntimeType,
  proxyMode: ProxyMode,
  quiet = false,
): Promise<void> {
  if (proxyMode !== "shared" || runtimeType === "openclaw") return;
  const proxyComposePath = join(projectDir, "docker-compose.proxy.yml");
  if (!await Bun.file(proxyComposePath).exists()) {
    const runtime = getRuntime(runtimeType);
    if (runtime.proxyComposeTemplate) {
      await Bun.write(proxyComposePath, runtime.proxyComposeTemplate(projectName));
    }
  }
  await runCompose(projectDir, "up", {
    composePath: proxyComposePath,
    projectName: `${projectName}-proxy`,
    quiet,
  });
}

async function syncInstanceRuntimeModelConfig(options: {
  projectName: string;
  projectDir: string;
  entry: ProjectEntry;
  instDir: string;
  llm: LlmProvider;
  modelSlug?: string;
}): Promise<void> {
  const { projectName, projectDir, entry, instDir, llm, modelSlug } = options;
  const config = await readProjectConfig(projectDir);
  const processor = config?.processor ?? entry.processor;
  const { runtime } = resolveRuntimeConfig(config, entry);
  const configPath = join(instDir, runtime.runtimeDirName, runtime.configFileName);
  const templateConfig = runtime.configTemplate(
    projectName,
    processor,
    llm,
    modelSlug?.trim() ? { modelSlug } : undefined,
  );
  const existingConfig = await Bun.file(configPath).text().catch(() => null);
  await Bun.write(
    configPath,
    existingConfig ? runtime.mergeConfig(templateConfig, existingConfig) : templateConfig,
  );
}

export async function spawn(options: {
  project: string;
  userId: string;
  context?: Record<string, string>;
  env?: Record<string, string>;
  autoStart?: boolean;
  llm?: LlmProvider;
  apiKey?: string;
  baseUrl?: string | null;
  quiet?: boolean;
}): Promise<{ userId: string; port: number }> {
  const { project, userId, context, env, autoStart = true, llm, apiKey, baseUrl, quiet = false } = options;

  // Validate userId (security: prevents path traversal via programmatic API)
  validateName(userId, "user ID");

  const { name: projectName, entry } = await resolveProjectName(project);
  const projectDir = entry.path;
  const config = await readProjectConfig(projectDir);

  // Determine runtime
  const { runtimeType, runtime, proxyMode } = resolveRuntimeConfig(config, entry);

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
    const workspaceLayout = resolveWorkspaceLayout(projectDir, userId, runtimeType);
    const rtDir = runtime.runtimeDirName;

    // Copy config files from template to instance
    const tmplDir = templateDir(projectDir);

    // Copy main config file + additional config files in parallel
    const configFilesToCopy = [
      { src: join(tmplDir, "config", runtime.configFileName), dest: join(instDir, rtDir, runtime.configFileName) },
      ...runtime.additionalConfigFiles.map((f) => ({
        src: join(tmplDir, "config", f),
        dest: join(instDir, rtDir, f),
      })),
    ];
    await Promise.all(configFilesToCopy.map(async ({ src, dest }) => {
      const file = Bun.file(src);
      if (await file.exists()) {
        await Bun.write(dest, await file.arrayBuffer());
      }
    }));

    // Copy shared template files (SOUL.md, AGENTS.md, skills/) into instance workspace
    const workspaceDir = workspaceLayout.workspaceRoot;
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

    const envContent = env
      ? Object.entries(env).map(([k, v]) => validateEnvEntry(k, v)).join("\n") + "\n"
      : "";
    await Bun.write(join(instDir, "instance.env"), envContent);

    // Write .env.model for per-instance proxy config (api-proxy reads this)
    // Only write if llm+apiKey provided, otherwise use default empty template
    if (llm && apiKey) {
      await writeInstanceModelEnv(instDir, { provider: llm, apiKey, baseUrl: baseUrl ?? null });
    } else if (!await fileExists(join(instDir, ".env.model"))) {
      // Default template for project-level .env fallback
      await writeInstanceModelEnv(instDir, { provider: "gemini", apiKey: "", baseUrl: null });
    }

    // Write compose (always regenerate)
    let composeContent: string;
    if (runtimeType === "openclaw") {
      composeContent = instanceComposeTemplate(projectName, userId, port, proxyMode);
    } else {
      composeContent = runtime.instanceComposeTemplate(projectName, userId, port, proxyMode);
    }
    const composePath = join(instDir, COMPOSE_FILENAME);
    await Bun.write(composePath, composeContent);

    // Start if requested
    if (autoStart) {
      // Ensure shared proxy is running (generates compose if needed, starts it)
      if (proxyMode === "shared" && runtimeType !== "openclaw") {
        const proxyComposePath = join(projectDir, "docker-compose.proxy.yml");
        if (!await Bun.file(proxyComposePath).exists()) {
          // Generate proxy compose if missing
          if (runtime.proxyComposeTemplate) {
            await Bun.write(proxyComposePath, runtime.proxyComposeTemplate(projectName));
          }
        }
        await runCompose(projectDir, "up", {
          composePath: proxyComposePath,
          projectName: `${projectName}-proxy`,
          quiet,
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
        quiet,
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
  options?: { keepData?: boolean; quiet?: boolean },
): Promise<void> {
  const { projectName, projectDir, entry, instDir, composePath, composeProject } =
    await resolveInstance(project, userId);

  const config = await readProjectConfig(projectDir);
  const { runtimeType, proxyMode } = resolveRuntimeConfig(config, entry);
  const connectContainer = (proxyMode === "shared" && runtimeType !== "openclaw")
    ? { container: `${projectName}-api-proxy`, network: `${composeProject}_instance-net` }
    : undefined;

  try {
    await runCompose(projectDir, "down", {
      composePath,
      projectName: composeProject,
      connectContainer,
      quiet: options?.quiet,
    });
  } catch (err) {
    if (!options?.quiet) {
      console.warn(`⚠ Could not stop containers: ${(err as Error).message}`);
    }
  }

  if (!options?.keepData) {
    await rm(instDir, { recursive: true, force: true });
  }

  await removeInstance(projectName, userId);
}

/**
 * Stop a running instance's containers without destroying them.
 * Data, volumes, and registry entry are preserved.
 */
export async function stopInstance(
  project: string,
  userId: string,
  options?: ManagedInstanceControlOptions,
): Promise<void> {
  const { projectDir, composePath, composeProject } =
    await resolveInstance(project, userId);

  await runCompose(projectDir, "stop", {
    composePath,
    projectName: composeProject,
    quiet: options?.quiet,
  });
}

/**
 * Start a previously stopped instance's containers.
 * Containers must already exist (created by spawn).
 */
export async function startInstance(
  project: string,
  userId: string,
  options?: ManagedInstanceControlOptions,
): Promise<{ port: number }> {
  const { projectDir, instance, composePath, composeProject } =
    await resolveInstance(project, userId);

  await runCompose(projectDir, "start", {
    composePath,
    projectName: composeProject,
    quiet: options?.quiet,
  });

  return { port: instance.port };
}

/**
 * Recreate a managed instance with the same semantics as `claw-farm up --user`.
 * This ensures shared-proxy wiring and compose recreation happen consistently.
 */
export async function upInstance(
  project: string,
  userId: string,
  options?: ManagedInstanceControlOptions,
): Promise<{ port: number }> {
  const { projectName, projectDir, entry, instance, composePath, composeProject } =
    await resolveInstance(project, userId);

  const config = await readProjectConfig(projectDir);
  const { runtimeType, proxyMode } = resolveRuntimeConfig(config, entry);

  await ensureSharedProxy(projectDir, projectName, runtimeType, proxyMode, options?.quiet ?? false);
  await runCompose(projectDir, "up", {
    composePath,
    projectName: composeProject,
    connectContainer: sharedProxyConnect(projectName, userId, runtimeType, proxyMode),
    quiet: options?.quiet,
  });

  return { port: instance.port };
}

/**
 * Tear down a managed instance with the same semantics as `claw-farm down --user`.
 * Containers are removed and shared-proxy network links are disconnected.
 */
export async function downInstance(
  project: string,
  userId: string,
  options?: ManagedInstanceControlOptions,
): Promise<void> {
  const { projectName, projectDir, entry, composePath, composeProject } =
    await resolveInstance(project, userId);

  const config = await readProjectConfig(projectDir);
  const { runtimeType, proxyMode } = resolveRuntimeConfig(config, entry);

  await runCompose(projectDir, "down", {
    composePath,
    projectName: composeProject,
    connectContainer: sharedProxyConnect(projectName, userId, runtimeType, proxyMode),
    quiet: options?.quiet,
  });
}

export async function listInstances(
  project: string,
): Promise<InstanceEntry[]> {
  const { name: projectName } = await resolveProjectName(project);
  return registryListInstances(projectName);
}

export async function getInstanceRuntimeStatus(
  project: string,
  userId: string,
): Promise<InstanceRuntimeStatus> {
  const { projectDir, composePath, composeProject } = await resolveInstance(project, userId);
  const status = await getComposeStatus(projectDir, {
    composePath,
    projectName: composeProject,
  });
  return { status, composePath, composeProject };
}

/**
 * Update per-instance model routing without forcing callers to reach into src/* internals.
 * This writes the instance's sidecar env override and syncs runtime config model/provider fields.
 */
export async function applyInstanceModelControl(
  options: ApplyInstanceModelControlOptions,
): Promise<void> {
  const { project, userId, llm, apiKey, modelSlug, baseUrl } = options;
  if (!apiKey.trim()) {
    throw new Error("apiKey is required");
  }

  const { projectName, projectDir, entry, instDir } = await resolveInstance(project, userId);

  await writeInstanceModelEnv(instDir, {
    provider: llm,
    apiKey,
    baseUrl: baseUrl ?? null,
  });
  await syncInstanceRuntimeModelConfig({
    projectName,
    projectDir,
    entry,
    instDir,
    llm,
    modelSlug,
  });
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
