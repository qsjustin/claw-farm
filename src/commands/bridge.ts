import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { copyTemplateFiles, despawn, downInstance, getInstanceRuntimeStatus, spawn, upInstance, applyInstanceModelControl } from "../lib/api.ts";
import { readProjectConfig, resolveRuntimeConfig, type LlmProvider } from "../lib/config.ts";
import { exportCommand } from "./export.ts";
import { importCommand } from "./import.ts";
import { instanceDir, templateDir } from "../lib/instance.ts";
import {
  createBridgeFailure,
  createBridgeSuccess,
  type BridgeErrorCode,
  type BridgeFailure,
  type BridgeResponse,
  type BridgeRuntimeState,
  type BridgeSuccess,
} from "../lib/bridge-response.ts";
import { resolveWorkspaceLayout, validateWorkspaceLayout } from "../lib/workspace-layout.ts";
import { fillUserTemplate } from "../templates/USER.template.md.ts";
import { getInstance, resolveProjectName, validateName } from "../lib/registry.ts";

const INSTANCE_OPERATIONS = new Set([
  "instance.create",
  "instance.start",
  "instance.stop",
  "instance.restart",
  "instance.delete",
  "instance.sync",
  "instance.export",
  "instance.import",
  "instance.applyModelControl",
  "agent.create",
  "agent.updateConfig",
]);

function emit(value: BridgeResponse): void {
  console.log(JSON.stringify(value));
}

class BridgeCommandError extends Error {
  constructor(
    readonly errorCode: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeCommandError";
  }
}

function parseJsonPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON payload must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${(error as Error).message}`);
  }
}

async function readPayload(args: string[]): Promise<Record<string, unknown>> {
  const inline = args.slice(1).join(" ").trim();
  if (inline) {
    return parseJsonPayload(inline);
  }
  if (process.stdin.isTTY) {
    return {};
  }
  const raw = (await new Response(Bun.stdin).text()).trim();
  if (!raw) return {};
  return parseJsonPayload(raw);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function observedAt(): string {
  return new Date().toISOString();
}

function validateBridgeName(value: string, label: string): void {
  try {
    validateName(value, label);
  } catch (error) {
    throw new BridgeCommandError("invalid-payload", error instanceof Error ? error.message : String(error));
  }
}

function bridgeSuccess(input: {
  action: string;
  message: string;
  project?: string;
  userId?: string;
  runtimeState?: BridgeRuntimeState;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): BridgeSuccess {
  return createBridgeSuccess({
    action: input.action,
    message: input.message,
    observedAt: observedAt(),
    project: input.project,
    userId: input.userId,
    runtimeState: input.runtimeState,
    metadata: input.metadata,
    extra: input.extra,
  });
}

function bridgeFailure(input: {
  action: string;
  message: string;
  errorCode: BridgeErrorCode;
  project?: string;
  userId?: string;
  runtimeState?: BridgeRuntimeState;
  retryable?: boolean;
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): BridgeFailure {
  return createBridgeFailure({
    action: input.action,
    message: input.message,
    observedAt: observedAt(),
    project: input.project,
    userId: input.userId,
    runtimeState: input.runtimeState,
    errorCode: input.errorCode,
    retryable: input.retryable,
    metadata: input.metadata,
    extra: input.extra,
  });
}

function parseRuntimeInstanceKey(payload: Record<string, unknown>): { project: string; userId: string } {
  const explicitProject = asString(payload.project);
  const explicitUserId = asString(payload.userId);
  if (explicitProject && explicitUserId) {
    return { project: explicitProject, userId: explicitUserId };
  }

  const runtimeInstanceKey = asString(payload.runtimeInstanceKey);
  if (runtimeInstanceKey) {
    const separator = runtimeInstanceKey.indexOf(":");
    if (separator <= 0 || separator >= runtimeInstanceKey.length - 1) {
      throw new BridgeCommandError("invalid-payload", 'runtimeInstanceKey must use the form "project:userId"');
    }
    return {
      project: runtimeInstanceKey.slice(0, separator),
      userId: runtimeInstanceKey.slice(separator + 1),
    };
  }

  throw new BridgeCommandError("invalid-payload", 'Missing project/userId or runtimeInstanceKey');
}

function parseLlmProvider(payload: Record<string, unknown>): LlmProvider {
  const provider = asString(payload.llm) ?? asString(payload.provider);
  if (provider === "gemini" || provider === "anthropic" || provider === "openai-compat") {
    return provider;
  }
  throw new BridgeCommandError("invalid-payload", 'llm/provider must be one of: gemini, anthropic, openai-compat');
}

function parseApiKey(payload: Record<string, unknown>): string {
  const apiKey = asString(payload.apiKey) ?? asString(payload.secretValue) ?? asString(payload.key);
  if (!apiKey || !apiKey.trim()) {
    throw new BridgeCommandError("invalid-payload", "apiKey/secretValue is required");
  }
  return apiKey;
}

function requireStringField(payload: Record<string, unknown>, field: string): string {
  const value = asString(payload[field]);
  if (!value?.trim()) {
    throw new BridgeCommandError("invalid-payload", `${field} is required`);
  }
  return value;
}

function safeBridgeContext(project?: string, userId?: string): { project?: string; userId?: string } {
  if (!project || !userId) return {};
  try {
    validateName(project, "project name");
    validateName(userId, "user ID");
    return { project, userId };
  } catch {
    return {};
  }
}

async function resolveBridgeContext(project: string, userId: string) {
  const resolved = await resolveProjectName(project);
  const config = await readProjectConfig(resolved.entry.path);
  const { runtimeType, runtime } = resolveRuntimeConfig(config, resolved.entry);
  const layout = resolveWorkspaceLayout(resolved.entry.path, userId, runtimeType);
  const instance = await getInstance(resolved.name, userId);
  return { resolved, runtimeType, runtime, layout, instance };
}

async function requireManagedInstance(
  operation: string,
  project: string,
  userId: string,
): Promise<
  | {
      resolved: Awaited<ReturnType<typeof resolveProjectName>>;
      runtimeType: Awaited<ReturnType<typeof resolveBridgeContext>>["runtimeType"];
      runtime: Awaited<ReturnType<typeof resolveBridgeContext>>["runtime"];
      layout: Awaited<ReturnType<typeof resolveBridgeContext>>["layout"];
    }
  | BridgeFailure
> {
  const context = await resolveBridgeContext(project, userId);
  if (!context.instance) {
    return bridgeFailure({
      action: operation,
      message: `Instance for user "${userId}" not found in "${context.resolved.name}"`,
      errorCode: "runtime-missing",
      project: context.resolved.name,
      userId,
    });
  }
  return context;
}

function toBridgeFailure(
  operation: string,
  payload: Record<string, unknown>,
  error: unknown,
): BridgeFailure {
  const explicitProject = asString(payload.project);
  const explicitUserId = asString(payload.userId);
  const context = safeBridgeContext(explicitProject, explicitUserId);
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof BridgeCommandError) {
    return bridgeFailure({
      action: operation,
      message,
      errorCode: error.errorCode,
      ...context,
    });
  }

  if (/already exists|conflict/i.test(message)) {
    return bridgeFailure({
      action: operation,
      message,
      errorCode: "runtime-conflict",
      ...context,
    });
  }

  if (/not found|missing/i.test(message)) {
    return bridgeFailure({
      action: operation,
      message,
      errorCode: "runtime-missing",
      ...context,
    });
  }

  if (/docker compose|docker network|command failed/i.test(message)) {
    return bridgeFailure({
      action: operation,
      message,
      errorCode: "runtime-command-failed",
      retryable: true,
      ...context,
    });
  }

  if (/invalid .*user ID|invalid .*project|agentSlug is required/i.test(message)) {
    return bridgeFailure({
      action: operation,
      message,
      errorCode: "invalid-payload",
      ...context,
    });
  }

  return bridgeFailure({
    action: operation,
    message,
    errorCode: "unknown",
    ...context,
  });
}

async function bridgeInstanceCreate(payload: Record<string, unknown>): Promise<BridgeSuccess> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  let context = asStringRecord(payload.context);
  const displayName = asString(payload.displayName);
  const autoStart = payload.autoStart === false || payload.noStart === true ? false : true;
  if (displayName && !context?.displayName) {
    context = { ...(context ?? {}), displayName };
  }

  const resolved = await resolveProjectName(project);
  const created = await spawn({
    project: resolved.name,
    userId,
    context: context && Object.keys(context).length > 0 ? context : undefined,
    autoStart,
    quiet: true,
  });

  let createdContext: Awaited<ReturnType<typeof resolveBridgeContext>>;
  try {
    createdContext = await resolveBridgeContext(resolved.name, userId);
    const layoutValidation = await validateWorkspaceLayout(createdContext.layout);
    if (!layoutValidation.ok) {
      throw new Error(`Workspace layout incomplete after create: ${layoutValidation.missing.join(", ")}`);
    }
  } catch (error) {
    try {
      await despawn(resolved.name, userId, { quiet: true });
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      const originalMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`${originalMessage}; cleanup failed: ${cleanupMessage}`);
    }
    throw error;
  }

  return bridgeSuccess({
    action: "instance.create",
    message: `Created instance "${userId}" for project "${resolved.name}"`,
    project: resolved.name,
    userId,
    runtimeState: autoStart ? "running" : "stopped",
    metadata: {
      workspacePath: createdContext.layout.workspaceRoot,
      workspaceLayoutVersion: "mvp-v1",
      workspaceLayoutValid: true,
    },
    extra: {
      port: created.port,
      userId: created.userId,
    },
  });
}

async function bridgeInstanceStart(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.start", project, userId);
  if ("ok" in context) return context;
  const started = await upInstance(project, userId, { quiet: true });
  return bridgeSuccess({
    action: "instance.start",
    message: `Started instance "${userId}"`,
    project: context.resolved.name,
    userId,
    runtimeState: "running",
    metadata: {
      workspacePath: context.layout.workspaceRoot,
    },
    extra: { port: started.port },
  });
}

async function bridgeInstanceStop(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.stop", project, userId);
  if ("ok" in context) return context;
  await downInstance(project, userId, { quiet: true });
  return bridgeSuccess({
    action: "instance.stop",
    message: `Stopped instance "${userId}"`,
    project: context.resolved.name,
    userId,
    runtimeState: "stopped",
    metadata: {
      workspacePath: context.layout.workspaceRoot,
    },
  });
}

async function bridgeInstanceRestart(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.restart", project, userId);
  if ("ok" in context) return context;
  await downInstance(project, userId, { quiet: true });
  await upInstance(project, userId, { quiet: true });
  return bridgeSuccess({
    action: "instance.restart",
    message: `Restarted instance "${userId}"`,
    project: context.resolved.name,
    userId,
    runtimeState: "running",
    metadata: {
      workspacePath: context.layout.workspaceRoot,
    },
  });
}

async function bridgeInstanceDelete(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.delete", project, userId);
  if ("ok" in context) return context;
  await despawn(project, userId, { quiet: true });
  return bridgeSuccess({
    action: "instance.delete",
    message: `Deleted instance "${userId}"`,
    project: context.resolved.name,
    userId,
    runtimeState: "deleted",
    metadata: {
      removedWorkspacePath: context.layout.instanceRoot,
    },
  });
}

async function bridgeInstanceSync(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.sync", project, userId);
  if ("ok" in context) return context;
  const status = await getInstanceRuntimeStatus(project, userId);
  const layoutValidation = await validateWorkspaceLayout(context.layout);
  return bridgeSuccess({
    action: "instance.sync",
    message: `Synchronized runtime state for "${userId}"`,
    project: context.resolved.name,
    userId,
    runtimeState: status.status,
    metadata: {
      composePath: status.composePath,
      composeProject: status.composeProject,
      workspacePath: context.layout.workspaceRoot,
      workspaceLayoutValid: layoutValidation.ok,
      missingWorkspaceDirs: layoutValidation.missing,
    },
    extra: {
      composePath: status.composePath,
      composeProject: status.composeProject,
    },
  });
}

async function bridgeInstanceApplyModelControl(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.applyModelControl", project, userId);
  if ("ok" in context) return context;
  const previousStatus = await getInstanceRuntimeStatus(project, userId);

  await applyInstanceModelControl({
    project,
    userId,
    llm: parseLlmProvider(payload),
    apiKey: parseApiKey(payload),
    modelSlug: asString(payload.modelSlug),
    baseUrl: asString(payload.baseUrl) ?? null,
  });

  let runtimeState = previousStatus.status;
  let restarted = false;
  if (previousStatus.status === "running") {
    await downInstance(project, userId, { quiet: true });
    await upInstance(project, userId, { quiet: true });
    runtimeState = "running";
    restarted = true;
  }

  return bridgeSuccess({
    action: "instance.applyModelControl",
    message: `Applied model control for "${userId}"`,
    project: context.resolved.name,
    userId,
    runtimeState,
    metadata: {
      composePath: previousStatus.composePath,
      composeProject: previousStatus.composeProject,
      workspacePath: context.layout.workspaceRoot,
    },
    extra: {
      restarted,
      composePath: previousStatus.composePath,
      composeProject: previousStatus.composeProject,
    },
  });
}

async function bridgeInstanceExport(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.export", project, userId);
  if ("ok" in context) return context;
  const currentStatus = await getInstanceRuntimeStatus(project, userId);

  const result = await exportCommand({
    projectDir: context.resolved.entry.path,
    projectName: context.resolved.name,
    userId,
    runtimeType: context.runtimeType,
    runtimeWorkspaceSlug: requireStringField(payload, "runtimeWorkspaceSlug"),
    exportRoot: requireStringField(payload, "exportRoot"),
    includedPaths: Array.isArray(payload.includedPaths)
      ? payload.includedPaths.filter((item): item is string => typeof item === "string")
      : undefined,
    excludedPaths: Array.isArray(payload.excludedPaths)
      ? payload.excludedPaths.filter((item): item is string => typeof item === "string")
      : undefined,
    bundleFormat: asString(payload.bundleFormat) ?? undefined,
  });

  return bridgeSuccess({
    action: "instance.export",
    message: `Exported instance "${userId}" bundle`,
    project: context.resolved.name,
    userId,
    runtimeState: currentStatus.status,
    metadata: {
      exportRoot: requireStringField(payload, "exportRoot"),
      bundleChecksum: result.bundleChecksum,
      bundleFileCount: result.fileCount,
    },
    extra: {
      bundlePath: result.bundlePath,
      manifestPath: result.manifestPath,
      checksumPath: result.checksumPath,
      fileCount: result.fileCount,
      sizeBytes: result.sizeBytes,
      bundleChecksum: result.bundleChecksum,
    },
  });
}

async function bridgeInstanceImport(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateBridgeName(userId, "user ID");
  const context = await requireManagedInstance("instance.import", project, userId);
  if ("ok" in context) return context;
  const currentStatus = await getInstanceRuntimeStatus(project, userId);

  const result = await importCommand({
    projectDir: context.resolved.entry.path,
    userId,
    runtimeType: context.runtimeType,
    runtimeWorkspaceSlug: requireStringField(payload, "runtimeWorkspaceSlug"),
    bundlePath: requireStringField(payload, "bundlePath"),
    manifestPath: requireStringField(payload, "manifestPath"),
  });

  return bridgeSuccess({
    action: "instance.import",
    message: `Imported instance "${userId}" bundle`,
    project: context.resolved.name,
    userId,
    runtimeState: currentStatus.status,
    metadata: {
      bundleChecksum: result.bundleChecksum,
      bundleFileCount: result.restoredFileCount,
    },
    extra: {
      restoredFileCount: result.restoredFileCount,
      bundleChecksum: result.bundleChecksum,
      rebuildRequired: result.rebuildRequired,
    },
  });
}

async function bridgeAgentCreate(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const agentSlug = asString(payload.agentSlug) ?? asString(payload.agentId) ?? asString(payload.slug);
  if (!agentSlug) {
    throw new BridgeCommandError("invalid-payload", "agentSlug is required");
  }
  validateBridgeName(userId, "user ID");
  validateBridgeName(agentSlug, "agent slug");

  const context = await requireManagedInstance("agent.create", project, userId);
  if ("ok" in context) return context;
  const instDir = instanceDir(context.resolved.entry.path, userId);
  const workspaceDir = context.layout.workspaceRoot;
  const agentDir = join(workspaceDir, "agents", agentSlug);
  const configPath = join(agentDir, "agent.config.json");

  if (!await Bun.file(workspaceDir).exists()) {
    return bridgeFailure({
      action: "agent.create",
      message: "未找到对应实例的 workspace。",
      errorCode: "runtime-missing",
      project: context.resolved.name,
      userId,
    });
  }
  if (await Bun.file(configPath).exists()) {
    return bridgeFailure({
      action: "agent.create",
      message: "运行时中已经存在同名 Agent 配置。",
      errorCode: "runtime-conflict",
      project: context.resolved.name,
      userId,
    });
  }

  await mkdir(agentDir, { recursive: true });
  await copyTemplateFiles(templateDir(context.resolved.entry.path), agentDir);

  const templatePath = join(templateDir(context.resolved.entry.path), "USER.template.md");
  let userContent = `# ${asString(payload.displayName) ?? agentSlug}\n\n- template: ${asString(payload.templateCode) ?? "unknown"}\n`;
  if (await Bun.file(templatePath).exists()) {
    const template = await Bun.file(templatePath).text();
    userContent = fillUserTemplate(template, userId, {
      agent_name: asString(payload.displayName) ?? agentSlug,
      template_code: asString(payload.templateCode) ?? "",
      template_version: asString(payload.templateVersion) ?? "",
      profile_code: asString(payload.profileCode) ?? "",
      runtime_mode: asString(payload.runtimeMode) ?? "",
    });
  }

  await Bun.write(join(agentDir, "USER.md"), userContent);
  await Bun.write(
    configPath,
    JSON.stringify(
      {
        templateCode: asString(payload.templateCode),
        templateVersion: asString(payload.templateVersion),
        displayName: asString(payload.displayName),
        basicConfig: asRecord(payload.basicConfig) ?? {},
      },
      null,
      2,
    ) + "\n",
  );

  return bridgeSuccess({
    action: "agent.create",
    message: `Created runtime agent "${agentSlug}"`,
    project: context.resolved.name,
    userId,
    metadata: {
      workspacePath: workspaceDir,
    },
    extra: { runtimeAgentKey: `${userId}:${agentSlug}` },
  });
}

async function bridgeAgentUpdateConfig(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const agentSlug = asString(payload.agentSlug) ?? asString(payload.agentId) ?? asString(payload.slug);
  if (!agentSlug) {
    throw new BridgeCommandError("invalid-payload", "agentSlug is required");
  }
  validateBridgeName(userId, "user ID");
  validateBridgeName(agentSlug, "agent slug");

  const context = await requireManagedInstance("agent.updateConfig", project, userId);
  if ("ok" in context) return context;
  const instDir = instanceDir(context.resolved.entry.path, userId);
  const configPath = join(instDir, context.runtime.runtimeDirName, "workspace", "agents", agentSlug, "agent.config.json");
  const file = Bun.file(configPath);

  if (!await file.exists()) {
    return bridgeFailure({
      action: "agent.updateConfig",
      message: "未找到可更新配置的 Agent 工作区。",
      errorCode: "runtime-missing",
      project: context.resolved.name,
      userId,
    });
  }

  const existing = JSON.parse(await file.text()) as Record<string, unknown>;
  const basicConfig = asRecord(payload.basicConfig) ?? {};
  await Bun.write(
    configPath,
    JSON.stringify(
      {
        ...existing,
        displayName: asString(payload.displayName) ?? existing.displayName,
        basicConfig,
      },
      null,
      2,
    ) + "\n",
  );

  return bridgeSuccess({
    action: "agent.updateConfig",
    message: `Updated runtime agent "${agentSlug}" config`,
    project: context.resolved.name,
    userId,
    extra: { runtimeAgentKey: `${userId}:${agentSlug}` },
  });
}

async function dispatch(operation: string, payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  if (!INSTANCE_OPERATIONS.has(operation)) {
    return bridgeFailure({
      action: operation,
      message: `Unsupported bridge operation: ${operation}`,
      errorCode: "invalid-operation",
    });
  }

  try {
    switch (operation) {
      case "instance.create":
        return await bridgeInstanceCreate(payload);
      case "instance.start":
        return await bridgeInstanceStart(payload);
      case "instance.stop":
        return await bridgeInstanceStop(payload);
      case "instance.restart":
        return await bridgeInstanceRestart(payload);
      case "instance.delete":
        return await bridgeInstanceDelete(payload);
      case "instance.sync":
        return await bridgeInstanceSync(payload);
      case "instance.export":
        return await bridgeInstanceExport(payload);
      case "instance.import":
        return await bridgeInstanceImport(payload);
      case "instance.applyModelControl":
        return await bridgeInstanceApplyModelControl(payload);
      case "agent.create":
        return await bridgeAgentCreate(payload);
      case "agent.updateConfig":
        return await bridgeAgentUpdateConfig(payload);
      default:
        return bridgeFailure({
          action: operation,
          message: `Unsupported bridge operation: ${operation}`,
          errorCode: "invalid-operation",
        });
    }
  } catch (error) {
    return toBridgeFailure(operation, payload, error);
  }
}

export async function bridgeCommand(args: string[]): Promise<void> {
  const operation = args[0];
  if (!operation) {
    emit(bridgeFailure({
      action: "bridge",
      message: "Missing bridge operation",
      errorCode: "invalid-operation",
    }));
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readPayload(args);
  } catch (error) {
    emit(bridgeFailure({
      action: operation,
      message: error instanceof Error ? error.message : String(error),
      errorCode: "invalid-payload",
    }));
    return;
  }

  const result = await dispatch(operation, payload);
  emit(result);
}
