/**
 * Programmatic API for claw-farm.
 * Import from "@permissionlabs/claw-farm" to spawn/despawn instances from code.
 *
 * Both CLI commands and external callers use these functions.
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { chmod, chown, mkdir, readdir, cp, rm, stat } from "node:fs/promises";
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

import { instanceComposeTemplate, buildInstanceCompose } from "../templates/docker-compose.instance.yml.ts";
import { fillUserTemplate } from "../templates/USER.template.md.ts";
import {
  dockerNetworkConnect,
  getComposeStatus,
  runCompose,
  sharedProxyConnect,
  COMPOSE_FILENAME,
} from "./compose.ts";
import { migrateToMulti } from "./migrate.ts";
import { getRuntime } from "../runtimes/index.ts";
import type { RuntimeType, ProxyMode } from "../runtimes/interface.ts";
import {
  upsertRuntimeInstance,
  updateRuntimeInstanceStatus,
  removeRuntimeInstance,
} from "./runtime-instance-registry.ts";

export type { InstanceEntry, ProjectEntry };
export type { LlmProvider };
export { getInstance, getProject };

export type InstanceRuntimeState = "running" | "stopped" | "unknown";

export interface InstanceRuntimeStatus {
  status: InstanceRuntimeState;
  composePath: string;
  composeProject: string;
}

export interface DespawnOptions {
  keepData?: boolean;
  deleteData?: boolean;
  quiet?: boolean;
}

export function shouldPreserveInstanceData(
  runtimeType: RuntimeType,
  options?: DespawnOptions,
): boolean {
  return options?.keepData === true || (runtimeType === "hermes" && options?.deleteData !== true);
}

async function refreshRuntimeTemplateConfig(options: {
  projectName: string;
  tmplDir: string;
  runtime: ReturnType<typeof getRuntime>;
  processor: "builtin" | "mem0";
  llm: LlmProvider;
  proxyMode: ProxyMode;
  baseUrl?: string | null;
}): Promise<void> {
  const configDir = join(options.tmplDir, "config");
  await mkdir(configDir, { recursive: true });

  const configPath = join(configDir, options.runtime.configFileName);
  const templateOptions =
    options.baseUrl !== undefined
      ? { baseUrl: options.baseUrl, useProxy: options.proxyMode !== "none" }
      : options.proxyMode === "none"
        ? { useProxy: false }
        : undefined;
  const templateConfig = options.runtime.configTemplate(
    options.projectName,
    options.processor,
    options.llm,
    templateOptions,
  );
  const existing = Bun.file(configPath);
  if (await existing.exists()) {
    await Bun.write(configPath, options.runtime.mergeConfig(templateConfig, await existing.text()));
    return;
  }
  await Bun.write(configPath, templateConfig);
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function chownTreeIfNeeded(path: string, uid: number, gid: number): Promise<void> {
  const info = await stat(path);
  if (info.uid !== uid || info.gid !== gid) {
    await chown(path, uid, gid);
  }
  if (!info.isDirectory()) return;

  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await chownTreeIfNeeded(child, uid, gid);
    } else if (entry.isFile()) {
      const childInfo = await stat(child);
      if (childInfo.uid !== uid || childInfo.gid !== gid) {
        await chown(child, uid, gid);
      }
    }
  }
}

async function ensureRuntimeContainerWritable(options: {
  instDir: string;
  runtimeType: RuntimeType;
}): Promise<void> {
  if (options.runtimeType !== "openclaw") return;
  const uid = parsePositiveIntegerEnv("OPENCLAW_CONTAINER_UID", 1000);
  const gid = parsePositiveIntegerEnv("OPENCLAW_CONTAINER_GID", 1000);
  await chownTreeIfNeeded(join(options.instDir, "openclaw"), uid, gid);
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
  /** #159B: Enable per-instance weixin sidecar */
  enableWeixinSidecar?: boolean;
  /** #159B: Per-instance weixin sidecar port */
  weixinSidecarPort?: number;
  /** #159B: Per-instance weixin env file name */
  weixinEnvFile?: string;
  /** #159B: ClawBay ManagedInstance.id for token provisioning */
  managedInstanceId?: string;
  /** #159B: ClawBay API URL for token provisioning */
  clawBayApiUrl?: string;
  /** #159B: ClawBay admin token for token provisioning */
  clawBayAdminToken?: string;
}

function runtimeAttachNetworks(): string[] {
  return (process.env.CLAW_FARM_RUNTIME_ATTACH_NETWORKS ?? "")
    .split(",")
    .map((network) => network.trim())
    .filter(Boolean);
}

function resolveDockerHostInstanceDir(instDir: string): string | undefined {
  const hostRoot = process.env.RUNTIME_INSTANCES_HOST_ROOT?.trim();
  if (!hostRoot) return undefined;

  const runtimeRoot = process.env.RUNTIME_INSTANCES_ROOT?.trim() || process.env.HOME;
  if (!runtimeRoot) {
    throw new Error("RUNTIME_INSTANCES_HOST_ROOT requires RUNTIME_INSTANCES_ROOT or HOME");
  }

  const resolvedRuntimeRoot = resolve(runtimeRoot);
  const resolvedInstDir = resolve(instDir);
  const rel = relative(resolvedRuntimeRoot, resolvedInstDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Instance directory is outside runtime instances root");
  }

  return join(hostRoot, rel);
}

async function connectRuntimeAttachNetworks(input: {
  projectName: string;
  userId: string;
  runtimeType: RuntimeType;
  quiet?: boolean;
}): Promise<void> {
  const networks = runtimeAttachNetworks();
  if (networks.length === 0) return;

  const runtime = getRuntime(input.runtimeType);
  const container = `${input.projectName}-${input.userId}-${runtime.runtimeDirName}`;
  for (const network of networks) {
    await dockerNetworkConnect(network, container, {
      quiet: input.quiet,
      required: true,
    });
  }
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

export async function writeInstanceModelEnv(
  instDir: string,
  input: InstanceModelEnvInput,
): Promise<void> {
  const modelEnvPath = join(instDir, ".env.model");
  await Bun.write(modelEnvPath, renderInstanceModelEnv(input));
  await chmod(modelEnvPath, 0o600);
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
  baseUrl?: string | null;
}): Promise<void> {
  const { projectName, projectDir, entry, instDir, llm, modelSlug, baseUrl } = options;
  const config = await readProjectConfig(projectDir);
  const processor = config?.processor ?? entry.processor;
  const { runtime, proxyMode } = resolveRuntimeConfig(config, entry);
  const configPath = join(instDir, runtime.runtimeDirName, runtime.configFileName);
  const templateOptions = {
    ...(modelSlug?.trim() ? { modelSlug } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    useProxy: proxyMode !== "none"
  };
  const templateConfig = runtime.configTemplate(
    projectName,
    processor,
    llm,
    templateOptions,
  );
  const existingConfig = await Bun.file(configPath).text().catch(() => null);
  await Bun.write(
    configPath,
    existingConfig ? runtime.mergeConfig(templateConfig, existingConfig) : templateConfig,
  );

  if (runtime.name === "hermes") {
    await syncHermesConfigYaml(instDir, llm, modelSlug, baseUrl);
  }
}

async function syncHermesConfigYaml(
  instDir: string,
  llm: LlmProvider,
  modelSlug?: string,
  baseUrl?: string | null,
): Promise<void> {
  const configYamlPath = join(instDir, "hermes", "config.yaml");
  const file = Bun.file(configYamlPath);
  if (!await file.exists()) {
    return;
  }
  let content = await file.text();

  const hermesProvider = llm === "openai-compat" ? "custom" : llm;
  const resolvedModel = modelSlug?.trim() ?? undefined;
  const resolvedBaseUrl = baseUrl?.trim() ?? undefined;

  if (resolvedModel) {
    content = content.replace(
      /^(\s*)default:\s*"[^"]*"/m,
      `$1default: "${resolvedModel}"`,
    );
    content = content.replace(
      /^(\s*)(?:model|default):\s*"[^"]*"/m,
      `$1default: "${resolvedModel}"`,
    );
  }

  content = content.replace(
    /^(\s*)provider:\s*"[^"]*"/m,
    `$1provider: "${hermesProvider}"`,
  );

  if (resolvedBaseUrl) {
    content = content.replace(
      /^(\s*)base_url:\s*"[^"]*"/m,
      `$1base_url: "${resolvedBaseUrl}"`,
    );
  }

  await Bun.write(configYamlPath, content);
}

async function writeInstanceCompose(options: {
  projectName: string;
  userId: string;
  port: number;
  instDir: string;
  runtimeType: RuntimeType;
  runtime: ReturnType<typeof getRuntime>;
  proxyMode: ProxyMode;
  gatewayAllowAllUsers?: boolean;
  /** #159B: Enable per-instance weixin sidecar */
  enableWeixinSidecar?: boolean;
  /** #159B: Per-instance weixin sidecar port (default: 8787) */
  weixinSidecarPort?: number;
  /** #159B: Per-instance weixin env file name (default: .env.weixin) */
  weixinEnvFile?: string;
}): Promise<string> {
  const instanceHostDir = resolveDockerHostInstanceDir(options.instDir);
  const enableWeixin = options.enableWeixinSidecar ?? false;

  let composeContent: string;
  if (enableWeixin && options.runtimeType === "openclaw") {
    // #159B: Use buildInstanceCompose for weixin sidecar support
    composeContent = buildInstanceCompose({
      projectName: options.projectName,
      userId: options.userId,
      port: options.port,
      proxyMode: options.proxyMode,
      instanceHostDir,
      enableWeixinSidecar: true,
      weixinSidecarPort: options.weixinSidecarPort,
      weixinEnvFile: options.weixinEnvFile,
    });
  } else if (options.runtimeType === "openclaw") {
    composeContent = instanceComposeTemplate(
      options.projectName,
      options.userId,
      options.port,
      options.proxyMode,
      instanceHostDir,
    );
  } else if (enableWeixin) {
    // #159B: Non-openclaw runtime with weixin sidecar — pass sidecar options to runtime template
    composeContent = options.runtime.instanceComposeTemplate(
      options.projectName,
      options.userId,
      options.port,
      options.proxyMode,
      instanceHostDir,
      options.gatewayAllowAllUsers,
      {
        enableWeixinSidecar: true,
        weixinEnvFile: options.weixinEnvFile ?? ".env.weixin",
        weixinSidecarPort: options.weixinSidecarPort ?? 8787,
      },
    );
  } else {
    composeContent = options.runtime.instanceComposeTemplate(
      options.projectName,
      options.userId,
      options.port,
      options.proxyMode,
      instanceHostDir,
      options.gatewayAllowAllUsers,
    );
  }
  const composePath = join(options.instDir, COMPOSE_FILENAME);
  await Bun.write(composePath, composeContent);
  return composePath;
}

export async function spawn(options: {
  project: string;
  userId: string;
  context?: Record<string, string>;
  env?: Record<string, string>;
  autoStart?: boolean;
  llm?: LlmProvider;
  apiKey?: string;
  apiKeyRef?: string;
  profileRef?: string;
  baseUrl?: string | null;
  quiet?: boolean;
  gatewayAllowAllUsers?: boolean;
  /** #159B: Enable per-instance weixin sidecar */
  enableWeixinSidecar?: boolean;
  /** #159B: Per-instance weixin sidecar port */
  weixinSidecarPort?: number;
  /** #159B: Per-instance weixin env file name */
  weixinEnvFile?: string;
  /** #159B: ClawBay ManagedInstance.id for token provisioning */
  managedInstanceId?: string;
  /** #159B: ClawBay API URL for token provisioning */
  clawBayApiUrl?: string;
  /** #159B: ClawBay admin token for token provisioning */
  clawBayAdminToken?: string;
}): Promise<{ userId: string; port: number }> {
  const {
    project,
    userId,
    context,
    env,
    autoStart = true,
    llm,
    apiKey,
    apiKeyRef,
    profileRef,
    baseUrl,
    quiet = false,
    enableWeixinSidecar = false,
    weixinSidecarPort,
    weixinEnvFile,
    managedInstanceId,
    clawBayApiUrl,
    clawBayAdminToken,
  } = options;

  // Validate userId (security: prevents path traversal via programmatic API)
  validateName(userId, "user ID");

  const { name: projectName, entry } = await resolveProjectName(project);
  const projectDir = entry.path;
  const config = await readProjectConfig(projectDir);

  // Resolve gatewayAllowAllUsers: explicit option > project config > default false
  const gatewayAllowAllUsers = options.gatewayAllowAllUsers ?? config?.gatewayAllowAllUsers ?? false;

  // Determine runtime
  const { runtimeType, runtime, proxyMode } = resolveRuntimeConfig(config, entry);

  // Auto-migrate if needed
  if (!entry.multiInstance && !config?.multiInstance) {
    await migrateToMulti(projectName, projectDir);
  }

  // Register instance (validates userId again, acquires lock)
  const { port, weixinSidecarPort: allocatedSidecarPort } = await addInstance(projectName, userId);
  // Use explicitly provided sidecar port, or the one allocated from registry
  const effectiveSidecarPort = weixinSidecarPort ?? allocatedSidecarPort;

  let runtimeRegistryCreated = false;

  // From here, if anything fails, we must roll back the registry entry
  try {
    // Create instance dirs (runtime-aware)
    const instDir = await ensureInstanceDirs(projectDir, userId, runtimeType);
    const workspaceLayout = resolveWorkspaceLayout(projectDir, userId, runtimeType);
    const rtDir = runtime.runtimeDirName;

    // Copy config files from template to instance
    const tmplDir = templateDir(projectDir);
    await refreshRuntimeTemplateConfig({
      projectName,
      tmplDir,
      runtime,
      processor: config?.processor ?? entry.processor,
      llm: llm ?? config?.llm ?? "gemini",
      proxyMode,
      baseUrl,
    });

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
    const composePath = await writeInstanceCompose({
      projectName,
      userId,
      port,
      instDir,
      runtimeType,
      runtime,
      proxyMode,
      gatewayAllowAllUsers,
      enableWeixinSidecar,
      weixinSidecarPort: effectiveSidecarPort,
      weixinEnvFile,
    });
    await ensureRuntimeContainerWritable({ instDir, runtimeType });

    // #159B Phase 3: Provision weixin sidecar token after compose is ready
    // Fail-closed: if weixin sidecar is enabled but provisioning inputs are missing, abort
    if (enableWeixinSidecar) {
      const missingInputs: string[] = [];
      if (!managedInstanceId) missingInputs.push("managedInstanceId");
      if (!clawBayApiUrl) missingInputs.push("clawBayApiUrl");
      if (!clawBayAdminToken) missingInputs.push("clawBayAdminToken");
      if (missingInputs.length > 0) {
        throw new Error(
          `Weixin sidecar enabled but missing provisioning inputs: ${missingInputs.join(", ")}. ` +
          "Set enableWeixinSidecar=false or provide all required inputs."
        );
      }
    }

    if (enableWeixinSidecar && managedInstanceId && clawBayApiUrl && clawBayAdminToken) {
      try {
        const envFile = join(instDir, weixinEnvFile ?? ".env.weixin");
        const sidecarPort = effectiveSidecarPort ?? 8787;

        const provisionResponse = await fetch(`${clawBayApiUrl.replace(/\/$/, "")}/api/internal/weixin-binding-provision`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-claw-bay-admin-token": clawBayAdminToken,
          },
          body: JSON.stringify({
            spec: {
              serviceRuntimeInstanceId: managedInstanceId,
              userId,
              sidecarCode: "weixin-auth-sidecar",
              ttlSeconds: 3600,
              consumer: {
                type: "compose-service",
                composeFile: composePath,
                serviceName: "weixin-sidecar",
                envFile,
              },
              healthUrl: `http://host.docker.internal:${sidecarPort}/healthz`,
              readinessTimeoutMs: 60_000,
              readinessIntervalMs: 2_000,
            },
            // #159B: On initial create, the sidecar container doesn't exist yet.
            // We skip the restart and let docker compose up bring it up instead.
            skipRestart: true,
          }),
        });

        if (!provisionResponse.ok) {
          const errorBody = await provisionResponse.json().catch(() => ({}));
          throw new Error(
            `Weixin sidecar token provisioning failed: ${provisionResponse.status} ${JSON.stringify(errorBody).slice(0, 200)}`
          );
        }

        const provisionResult = (await provisionResponse.json()) as { ok: boolean; tokenLast4?: string; error?: { message?: string } };
        if (!provisionResult.ok) {
          throw new Error(
            `Weixin sidecar token provisioning failed: ${provisionResult.error?.message ?? "unknown"}`
          );
        }

        if (!quiet) {
          console.log(`   🔑 Weixin sidecar token provisioned (last4: ${provisionResult.tokenLast4 ?? "?"})`);
        }
      } catch (provisionError) {
        if (!quiet) {
          console.error(`   ❌ Weixin sidecar token provisioning failed: ${provisionError instanceof Error ? provisionError.message : String(provisionError)}`);
        }
        throw provisionError;
      }
    }

    await upsertRuntimeInstance({
      project: projectName,
      userId,
      runtimeType,
      status: autoStart ? "starting" : "stopped",
      hostPort: port,
      displayName: context?.displayName,
      apiKeyRef,
      profileRef,
    });
    runtimeRegistryCreated = true;

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
      await connectRuntimeAttachNetworks({
        projectName,
        userId,
        runtimeType,
        quiet,
      });
      await updateRuntimeInstanceStatus(projectName, userId, "running");

      // Hermes generates config.yaml on first start with default model settings.
      // Override the model section with the correct provider/model/baseUrl
      // so new instances don't fall back to default anthropic/claude-opus-4.6.
      if (runtimeType === "hermes" && llm) {
        const configYamlPath = join(instDir, "hermes", "config.yaml");
        const maxWaitMs = 15_000;
        const pollIntervalMs = 1_000;
        let waited = 0;
        while (waited < maxWaitMs && !await Bun.file(configYamlPath).exists()) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          waited += pollIntervalMs;
        }
        if (await Bun.file(configYamlPath).exists()) {
          await syncHermesConfigYaml(instDir, llm, undefined, baseUrl ?? null);
          if (!quiet) {
            await runCompose(projectDir, "down", {
              composePath,
              projectName: composeProject,
              quiet: true,
            });
            await runCompose(projectDir, "up", {
              composePath,
              projectName: composeProject,
              quiet: true,
            });
          }
        }
      }
    }

    return { userId, port };
  } catch (err) {
    // Rollback: remove from registry on failure
    try {
      await removeInstance(projectName, userId);
    } catch {
      // Best effort rollback
    }
    if (runtimeRegistryCreated) {
      try {
        await updateRuntimeInstanceStatus(projectName, userId, "deleted", {
          ready: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Best effort rollback.
      }
    }
    throw err;
  }
}

export async function despawn(
  project: string,
  userId: string,
  options?: DespawnOptions & {
    /** #159B: ClawBay ManagedInstance.id for token revocation */
    managedInstanceId?: string;
    /** #159B: ClawBay API URL for token revocation */
    clawBayApiUrl?: string;
    /** #159B: ClawBay admin token for token revocation */
    clawBayAdminToken?: string;
  },
): Promise<void> {
  const { projectName, projectDir, entry, instDir, composePath, composeProject } =
    await resolveInstance(project, userId);

  const config = await readProjectConfig(projectDir);
  const { runtimeType, proxyMode } = resolveRuntimeConfig(config, entry);
  const preserveData = shouldPreserveInstanceData(runtimeType, options);
  await updateRuntimeInstanceStatus(projectName, userId, "deleting", { ready: false });
  const connectContainer = (proxyMode === "shared" && runtimeType !== "openclaw")
    ? { container: `${projectName}-api-proxy`, network: `${composeProject}_instance-net` }
    : undefined;

  // #159B: Revoke weixin sidecar tokens before tearing down (fail-closed)
  if (options?.managedInstanceId && options?.clawBayApiUrl && options?.clawBayAdminToken) {
    const revokeResponse = await fetch(`${options.clawBayApiUrl.replace(/\/$/, "")}/api/internal/weixin-binding-provision/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claw-bay-admin-token": options.clawBayAdminToken,
      },
      body: JSON.stringify({
        serviceRuntimeInstanceId: options.managedInstanceId,
        sidecarCode: "weixin-auth-sidecar",
      }),
    });
    if (!revokeResponse.ok) {
      const errorBody = await revokeResponse.json().catch(() => ({}));
      throw new Error(
        `Weixin sidecar token revocation failed: ${revokeResponse.status} ${JSON.stringify(errorBody).slice(0, 200)}`
      );
    }
  }

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

  if (!preserveData) {
    await rm(instDir, { recursive: true, force: true });
  }

  await removeInstance(projectName, userId);
  if (preserveData) {
    await updateRuntimeInstanceStatus(projectName, userId, "deleted", {
      ready: false,
      lastError: "Instance stopped; data retained.",
    });
  } else {
    await removeRuntimeInstance(projectName, userId);
  }
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
  const { projectName, projectDir, composePath, composeProject } =
    await resolveInstance(project, userId);

  await runCompose(projectDir, "stop", {
    composePath,
    projectName: composeProject,
    quiet: options?.quiet,
  });
  await updateRuntimeInstanceStatus(projectName, userId, "stopped", { ready: false });
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
  const { projectName, projectDir, entry, instance, composePath, composeProject } =
    await resolveInstance(project, userId);
  const config = await readProjectConfig(projectDir);
  const { runtimeType } = resolveRuntimeConfig(config, entry);
  await ensureRuntimeContainerWritable({ instDir: instanceDir(projectDir, userId), runtimeType });

  await runCompose(projectDir, "start", {
    composePath,
    projectName: composeProject,
    quiet: options?.quiet,
  });
  await connectRuntimeAttachNetworks({
    projectName,
    userId,
    runtimeType,
    quiet: options?.quiet,
  });
  await updateRuntimeInstanceStatus(projectName, userId, "running", { ready: true });

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
  const { runtimeType, runtime, proxyMode } = resolveRuntimeConfig(config, entry);
  const instDir = instanceDir(projectDir, userId);

  await ensureSharedProxy(projectDir, projectName, runtimeType, proxyMode, options?.quiet ?? false);
  await writeInstanceCompose({
    projectName,
    userId,
    port: instance.port,
    instDir,
    runtimeType,
    runtime,
    proxyMode,
    enableWeixinSidecar: options?.enableWeixinSidecar,
    weixinSidecarPort: options?.weixinSidecarPort ?? instance.weixinSidecarPort,
    weixinEnvFile: options?.weixinEnvFile,
  });

  // #159B: Rotate weixin sidecar token on rebuild/restore (fail-closed)
  if (options?.enableWeixinSidecar && options?.managedInstanceId && options?.clawBayApiUrl && options?.clawBayAdminToken) {
    const envFile = join(instDir, options.weixinEnvFile ?? ".env.weixin");
    const sidecarPort = options.weixinSidecarPort ?? instance.weixinSidecarPort ?? 8787;
    const rotateResponse = await fetch(`${options.clawBayApiUrl.replace(/\/$/, "")}/api/internal/weixin-binding-provision/rotate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-claw-bay-admin-token": options.clawBayAdminToken,
      },
      body: JSON.stringify({
        spec: {
          serviceRuntimeInstanceId: options.managedInstanceId,
          userId,
          sidecarCode: "weixin-auth-sidecar",
          ttlSeconds: 3600,
          consumer: {
            type: "compose-service",
            composeFile: composePath,
            serviceName: "weixin-sidecar",
            envFile,
          },
          healthUrl: `http://host.docker.internal:${sidecarPort}/healthz`,
          readinessTimeoutMs: 60_000,
          readinessIntervalMs: 2_000,
        },
      }),
    });
    if (!rotateResponse.ok) {
      const errorBody = await rotateResponse.json().catch(() => ({}));
      throw new Error(
        `Weixin sidecar token rotation failed: ${rotateResponse.status} ${JSON.stringify(errorBody).slice(0, 200)}`
      );
    }
  }

  await ensureRuntimeContainerWritable({ instDir, runtimeType });
  await runCompose(projectDir, "up", {
    composePath,
    projectName: composeProject,
    connectContainer: sharedProxyConnect(projectName, userId, runtimeType, proxyMode),
    quiet: options?.quiet,
  });
  await connectRuntimeAttachNetworks({
    projectName,
    userId,
    runtimeType,
    quiet: options?.quiet,
  });
  await updateRuntimeInstanceStatus(projectName, userId, "running", { ready: true });

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
  await updateRuntimeInstanceStatus(projectName, userId, "stopped", { ready: false });
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
  const { projectName, projectDir, composePath, composeProject } = await resolveInstance(project, userId);
  const status = await getComposeStatus(projectDir, {
    composePath,
    projectName: composeProject,
  });
  await updateRuntimeInstanceStatus(projectName, userId, status === "unknown" ? "unhealthy" : status);
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
    modelSlug,
  });
  await syncInstanceRuntimeModelConfig({
    projectName,
    projectDir,
    entry,
    instDir,
    llm,
    modelSlug,
    baseUrl: baseUrl ?? null,
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
