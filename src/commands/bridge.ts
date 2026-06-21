import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { copyTemplateFiles, despawn, downInstance, getInstanceRuntimeStatus, spawn, upInstance, stopInstance, applyInstanceModelControl } from "../lib/api.ts";
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
import { getInstance, getProject, removeInstance, resolveProjectName, validateName } from "../lib/registry.ts";
import {
  getRuntimeInstance,
  listRuntimeInstances,
  removeRuntimeInstance,
  redactedRuntimeInstance,
  resolveRuntimeInternalEndpoint,
  updateRuntimeInstanceStatus,
  type RuntimeInstanceRegistryEntry,
  type RuntimeInstanceStatus,
} from "../lib/runtime-instance-registry.ts";
import type { RuntimeType } from "../runtimes/interface.ts";

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
  "runtime.registry.list",
  "runtime.registry.get",
  "runtime.registry.sync",
  "runtime.registry.resolve",
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

export function buildRuntimeRegistrySyncExtra(input: {
  composeProject: string;
  runtimeInstance: ReturnType<typeof redactedRuntimeInstance> | null;
}): Record<string, unknown> {
  return {
    composeProject: input.composeProject,
    runtimeInstance: input.runtimeInstance,
  };
}

function parseRuntimeInstanceKey(payload: Record<string, unknown>): { project: string; userId: string } {
  const explicitProject = asString(payload.project);
  const explicitUserId = asString(payload.userId);
  if (explicitProject && explicitUserId) {
    return { project: explicitProject, userId: explicitUserId };
  }

  const runtimeInstanceKey = asString(payload.runtimeInstanceKey);
  if (runtimeInstanceKey) {
    const parts = runtimeInstanceKey.split(":").map((part) => part.trim());
    if (parts.length !== 2 && parts.length !== 3) {
      throw new BridgeCommandError("invalid-payload", 'runtimeInstanceKey must use the form "project:userId" or "project:userId:runtimeType"');
    }
    const [project, userId, keyRuntimeType] = parts;
    if (!project || !userId || (parts.length === 3 && !keyRuntimeType)) {
      throw new BridgeCommandError("invalid-payload", 'runtimeInstanceKey must use the form "project:userId" or "project:userId:runtimeType"');
    }
    const payloadRuntimeType = asString(payload.runtimeType);
    if (keyRuntimeType && payloadRuntimeType && keyRuntimeType !== payloadRuntimeType) {
      throw new BridgeCommandError("invalid-payload", `runtimeInstanceKey runtime type "${keyRuntimeType}" does not match payload runtimeType "${payloadRuntimeType}".`);
    }
    return {
      project,
      userId,
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

function parseRuntimeType(value: unknown): RuntimeType | undefined {
  if (value === undefined) return undefined;
  if (value === "openclaw" || value === "picoclaw" || value === "hermes") return value;
  throw new BridgeCommandError("invalid-payload", 'runtimeType must be one of: openclaw, picoclaw, hermes');
}

function parseRuntimeStatus(value: unknown): RuntimeInstanceStatus | undefined {
  if (value === undefined) return undefined;
  const statuses = new Set([
    "provisioning",
    "starting",
    "running",
    "unhealthy",
    "stopped",
    "deleting",
    "deleted",
    "migrating",
    "error",
  ]);
  if (typeof value === "string" && statuses.has(value)) return value as RuntimeInstanceStatus;
  throw new BridgeCommandError("invalid-payload", "status is not a valid runtime instance status");
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
  const apiKeyRef = asString(payload.apiKeyRef);
  const profileRef = asString(payload.profileRef);
  const autoStart = payload.autoStart === false || payload.noStart === true ? false : true;
  if (displayName && !context?.displayName) {
    context = { ...(context ?? {}), displayName };
  }

  // #159B: Parse per-instance weixin sidecar options from bridge payload
  const enableWeixinSidecar = payload.enableWeixinSidecar === true;
  const weixinSidecarPort = typeof payload.weixinSidecarPort === "number"
    ? payload.weixinSidecarPort
    : undefined;
  const weixinEnvFile = asString(payload.weixinEnvFile);
  const managedInstanceId = asString(payload.managedInstanceId);
  const clawBayApiUrl = asString(payload.clawBayApiUrl);
  const clawBayAdminToken = asString(payload.clawBayAdminToken);

  const resolved = await resolveProjectName(project);
  const payloadGatewayAllowAllUsers = typeof payload.gatewayAllowAllUsers === "boolean"
    ? payload.gatewayAllowAllUsers
    : undefined;
  const created = await spawn({
    project: resolved.name,
    userId,
    context: context && Object.keys(context).length > 0 ? context : undefined,
    autoStart,
    apiKeyRef,
    profileRef,
    quiet: true,
    gatewayAllowAllUsers: payloadGatewayAllowAllUsers,
    enableWeixinSidecar,
    weixinSidecarPort,
    weixinEnvFile,
    managedInstanceId,
    clawBayApiUrl,
    clawBayAdminToken,
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
      runtimeInstanceKey: `${resolved.name}:${userId}`,
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
  // #171: Lifecycle reads canonical sidecar spec — no enable/disable override.
  // Only forward rotation creds (managedInstanceId etc.) for token refresh.
  const started = await upInstance(project, userId, {
    quiet: true,
    weixinSidecarPort: typeof payload.weixinSidecarPort === "number" ? payload.weixinSidecarPort : undefined,
    weixinEnvFile: asString(payload.weixinEnvFile),
    managedInstanceId: asString(payload.managedInstanceId),
    clawBayApiUrl: asString(payload.clawBayApiUrl),
    clawBayAdminToken: asString(payload.clawBayAdminToken),
  });
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
  // #159B: Use stopInstance (compose stop) not downInstance (compose down).
  // stopInstance keeps containers/networks in stopped state so start can resume;
  // downInstance removes containers/networks, causing container name conflicts on restart.
  await stopInstance(project, userId, { quiet: true });
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
  // #171: Lifecycle reads canonical sidecar spec — no enable/disable override.
  // Only forward rotation creds for token refresh.
  await upInstance(project, userId, {
    quiet: true,
    weixinSidecarPort: typeof payload.weixinSidecarPort === "number" ? payload.weixinSidecarPort : undefined,
    weixinEnvFile: asString(payload.weixinEnvFile),
    managedInstanceId: asString(payload.managedInstanceId),
    clawBayApiUrl: asString(payload.clawBayApiUrl),
    clawBayAdminToken: asString(payload.clawBayAdminToken),
  });
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
  const runtimeType = parseRuntimeType(payload.runtimeType);
  const keepData = payload.keepData === true;
  const deleteData = payload.deleteData === true;
  if (keepData && deleteData) {
    throw new BridgeCommandError("invalid-payload", "Use only one of keepData or deleteData.");
  }

  let context: Awaited<ReturnType<typeof requireManagedInstance>>;
  try {
    context = await requireManagedInstance("instance.delete", project, userId);
  } catch (error) {
    const fallback = await bridgeInstanceDeleteRegistryFallback({
      project,
      userId,
      runtimeType,
      deleteData,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (fallback) return fallback;
    throw error;
  }

  if ("ok" in context) {
    const fallback = await bridgeInstanceDeleteRegistryFallback({
      project,
      userId,
      runtimeType,
      deleteData,
      reason: context.message,
    });
    return fallback ?? context;
  }

  await despawn(project, userId, {
    quiet: true,
    keepData,
    deleteData,
    // #159B: Pass weixin sidecar revocation config
    managedInstanceId: asString(payload.managedInstanceId),
    clawBayApiUrl: asString(payload.clawBayApiUrl),
    clawBayAdminToken: asString(payload.clawBayAdminToken),
  });
  return bridgeSuccess({
    action: "instance.delete",
    message: deleteData ? `Deleted instance "${userId}" and its data` : `Deleted instance "${userId}" with data retained when required by runtime policy`,
    project: context.resolved.name,
    userId,
    runtimeState: "deleted",
    metadata: buildSafeDeleteMetadata({
      project: context.resolved.name,
      userId,
      runtimeType: context.runtimeType,
      deleteData,
    }),
  });
}

async function bridgeInstanceDeleteRegistryFallback(input: {
  project: string;
  userId: string;
  runtimeType?: RuntimeType;
  deleteData: boolean;
  reason: string;
}): Promise<BridgeSuccess | null> {
  const entry = await findRuntimeInstanceDeleteFallbackEntry(input);
  if (!entry) {
    return null;
  }

  if (input.deleteData) {
    return bridgeInstanceDeleteDataFallback(input, entry);
  }

  const updated = await updateRuntimeInstanceStatus(entry.project, entry.userId, "deleted", {
    ready: false,
    lastError: "Control-plane cleanup fallback applied; runtime data retained.",
  });

  return bridgeSuccess({
    action: "instance.delete",
    message: `Deleted runtime registry entry "${entry.runtimeInstanceKey}" with data retained because the claw-farm project or instance workspace was incomplete.`,
    project: entry.project,
    userId: entry.userId,
    runtimeState: "deleted",
    metadata: {
      runtimeInstance: updated ? redactedRuntimeInstance(updated) : redactedRuntimeInstance(entry),
      dataDeleted: false,
      dataRetained: true,
      cleanupFallback: true,
      cleanupReason: sanitizeBridgeMetadataMessage(input.reason),
      requestedProject: input.project === entry.project ? undefined : input.project,
    },
  });
}

async function findRuntimeInstanceDeleteFallbackEntry(input: {
  project: string;
  userId: string;
  runtimeType?: RuntimeType;
}): Promise<RuntimeInstanceRegistryEntry | null> {
  const exact = await getRuntimeInstance(input.project, input.userId);
  if (exact) {
    if (input.runtimeType && exact.runtimeType !== input.runtimeType) {
      throw new BridgeCommandError(
        "invalid-payload",
        `Runtime instance "${input.project}:${input.userId}" is ${exact.runtimeType}, not ${input.runtimeType}.`,
      );
    }
    return exact;
  }

  const candidates = (await listRuntimeInstances({ runtimeType: input.runtimeType })).filter((entry) =>
    entry.userId === input.userId
  );
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length > 1) {
    throw new BridgeCommandError(
      "runtime-conflict",
      `Multiple runtime registry entries found for user "${input.userId}". Pass runtimeInstanceKey for the exact instance.`,
    );
  }
  return candidates[0];
}

async function bridgeInstanceDeleteDataFallback(
  input: {
    project: string;
    userId: string;
    deleteData: boolean;
    reason: string;
  },
  entry: RuntimeInstanceRegistryEntry,
): Promise<BridgeSuccess | null> {
  try {
    await despawn(entry.project, entry.userId, { quiet: true, deleteData: true });
  } catch {
    const project = await getProject(entry.project);
    if (!project) {
      throw new BridgeCommandError(
        "runtime-missing",
        `Cannot physically delete runtime data for "${entry.runtimeInstanceKey}" because project "${entry.project}" is not registered.`,
      );
    }
    const instDir = instanceDir(project.path, entry.userId);
    await rm(instDir, { recursive: true, force: true });
    try {
      await removeInstance(entry.project, entry.userId);
    } catch {
      // Registry instance may already be absent; runtime registry cleanup below is authoritative for service runtimes.
    }
    await removeRuntimeInstance(entry.project, entry.userId);
  }

  const updated = await getRuntimeInstance(entry.project, entry.userId);
  return bridgeSuccess({
    action: "instance.delete",
    message: `Deleted runtime registry entry "${entry.runtimeInstanceKey}" and its data via cleanup fallback.`,
    project: entry.project,
    userId: entry.userId,
    runtimeState: "deleted",
    metadata: {
      runtimeInstance: updated ? redactedRuntimeInstance(updated) : redactedRuntimeInstance(entry),
      dataDeleted: true,
      dataRetained: false,
      cleanupFallback: true,
      cleanupReason: sanitizeBridgeMetadataMessage(input.reason),
      requestedProject: input.project === entry.project ? undefined : input.project,
    },
  });
}

function sanitizeBridgeMetadataMessage(value: string): string {
  return value
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "[runtime-path]")
    .replace(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g, "[runtime-path]");
}

function buildSafeDeleteMetadata(input: {
  project: string;
  userId: string;
  runtimeType?: string;
  deleteData: boolean;
  cleanupFallback?: boolean;
  cleanupReason?: string;
  runtimeInstanceKey?: string;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    dataDeleted: input.deleteData,
    dataRetained: !input.deleteData,
  };
  if (input.runtimeType) {
    metadata.runtimeType = input.runtimeType;
  }
  if (input.cleanupFallback) {
    metadata.cleanupFallback = true;
    metadata.cleanupReason = input.cleanupReason
      ? sanitizeBridgeMetadataMessage(input.cleanupReason)
      : undefined;
  }
  return metadata;
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
      runtimeInstance: await getRuntimeInstance(context.resolved.name, userId).then((entry) =>
        entry ? redactedRuntimeInstance(entry) : null
      ),
    },
    extra: {
      composePath: status.composePath,
      composeProject: status.composeProject,
    },
  });
}

async function bridgeRuntimeRegistryList(payload: Record<string, unknown>): Promise<BridgeSuccess> {
  const runtimeType = parseRuntimeType(payload.runtimeType);
  const status = parseRuntimeStatus(payload.status);
  const project = asString(payload.project);
  const entries = (await listRuntimeInstances({ project, runtimeType, status })).filter((entry) =>
    status ? true : entry.status !== "deleted"
  );
  return bridgeSuccess({
    action: "runtime.registry.list",
    message: `Loaded ${entries.length} runtime instance registry entr${entries.length === 1 ? "y" : "ies"}.`,
    project,
    metadata: {
      count: entries.length,
    },
    extra: {
      instances: entries.map((entry) => redactedRuntimeInstance(entry)),
    },
  });
}

async function bridgeRuntimeRegistryGet(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const entry = await getRuntimeInstance(project, userId);
  if (!entry) {
    return bridgeFailure({
      action: "runtime.registry.get",
      message: `Runtime instance "${project}:${userId}" not found.`,
      errorCode: "runtime-missing",
      project,
      userId,
    });
  }
  return bridgeSuccess({
    action: "runtime.registry.get",
    message: `Loaded runtime instance "${entry.runtimeInstanceKey}".`,
    project,
    userId,
    runtimeState: entry.status === "running" ? "running" : entry.status === "stopped" ? "stopped" : "unknown",
    metadata: {
      runtimeInstance: redactedRuntimeInstance(entry),
    },
  });
}

async function bridgeRuntimeRegistrySync(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const context = await requireManagedInstance("runtime.registry.sync", project, userId);
  if ("ok" in context) return context;
  const status = await getInstanceRuntimeStatus(project, userId);
  const entry = await getRuntimeInstance(context.resolved.name, userId);
  return bridgeSuccess({
    action: "runtime.registry.sync",
    message: `Synchronized runtime registry for "${context.resolved.name}:${userId}".`,
    project: context.resolved.name,
    userId,
    runtimeState: status.status,
    metadata: {
      runtimeInstance: entry ? redactedRuntimeInstance(entry) : null,
    },
    extra: buildRuntimeRegistrySyncExtra({
      composeProject: status.composeProject,
      runtimeInstance: entry ? redactedRuntimeInstance(entry) : null,
    }),
  });
}

async function bridgeRuntimeRegistryResolve(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const entry = await getRuntimeInstance(project, userId);
  if (!entry) {
    return bridgeFailure({
      action: "runtime.registry.resolve",
      message: `Runtime instance "${project}:${userId}" not found.`,
      errorCode: "runtime-missing",
      project,
      userId,
    });
  }
  return bridgeSuccess({
    action: "runtime.registry.resolve",
    message: `Resolved runtime instance refs for "${entry.runtimeInstanceKey}".`,
    project,
    userId,
    runtimeState: entry.status === "running" ? "running" : entry.status === "stopped" ? "stopped" : "unknown",
    metadata: {
      runtimeInstanceKey: entry.runtimeInstanceKey,
      runtimeType: entry.runtimeType,
      status: entry.status,
      health: entry.health,
      endpointRef: entry.endpointRef,
      endpoint: resolveRuntimeInternalEndpoint(entry),
      apiKeyRef: entry.apiKeyRef ? "ref:***" : undefined,
      profileRef: entry.profileRef ? "ref:***" : undefined,
      dataVolumeRef: entry.dataVolumeRef,
      workspaceRef: entry.workspaceRef,
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
    // #171: Lifecycle reads canonical sidecar spec — no enable/disable override.
    // Only forward rotation creds for token refresh.
    await upInstance(project, userId, {
      quiet: true,
      weixinSidecarPort: typeof payload.weixinSidecarPort === "number" ? payload.weixinSidecarPort : undefined,
      weixinEnvFile: asString(payload.weixinEnvFile),
      managedInstanceId: asString(payload.managedInstanceId),
      clawBayApiUrl: asString(payload.clawBayApiUrl),
      clawBayAdminToken: asString(payload.clawBayAdminToken),
    });
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
      archiveRef: result.manifest.backupId,
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
  const archiveRef = asString(payload.archiveRef);
  const exportRoot = asString(payload.exportRoot);
  if (archiveRef) {
    validateBridgeName(archiveRef, "archive ref");
  }
  const bundlePath = archiveRef && exportRoot
    ? join(exportRoot, archiveRef, "instance.tar.zst")
    : requireStringField(payload, "bundlePath");
  const manifestPath = archiveRef && exportRoot
    ? join(exportRoot, archiveRef, "manifest.json")
    : requireStringField(payload, "manifestPath");

  const result = await importCommand({
    projectDir: context.resolved.entry.path,
    userId,
    runtimeType: context.runtimeType,
    runtimeWorkspaceSlug: requireStringField(payload, "runtimeWorkspaceSlug"),
    bundlePath,
    manifestPath,
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
      archiveRef: result.manifest.backupId,
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
      case "runtime.registry.list":
        return await bridgeRuntimeRegistryList(payload);
      case "runtime.registry.get":
        return await bridgeRuntimeRegistryGet(payload);
      case "runtime.registry.sync":
        return await bridgeRuntimeRegistrySync(payload);
      case "runtime.registry.resolve":
        return await bridgeRuntimeRegistryResolve(payload);
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
