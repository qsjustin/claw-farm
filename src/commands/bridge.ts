import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { copyTemplateFiles, despawn, downInstance, getInstanceRuntimeStatus, spawn, upInstance, applyInstanceModelControl } from "../lib/api.ts";
import { readProjectConfig, resolveRuntimeConfig, type LlmProvider } from "../lib/config.ts";
import { instanceDir, templateDir } from "../lib/instance.ts";
import { fillUserTemplate } from "../templates/USER.template.md.ts";
import { getInstance, resolveProjectName, validateName } from "../lib/registry.ts";

type BridgeErrorCode =
  | "invalid-operation"
  | "invalid-payload"
  | "runtime-missing"
  | "runtime-conflict"
  | "runtime-command-failed";

type BridgeFailure = {
  ok: false;
  errorCode: BridgeErrorCode;
  error: string;
};

type BridgeSuccess = Record<string, unknown> & { ok: true };
type BridgeResponse = BridgeSuccess | BridgeFailure;

const INSTANCE_OPERATIONS = new Set([
  "instance.create",
  "instance.start",
  "instance.stop",
  "instance.restart",
  "instance.delete",
  "instance.sync",
  "instance.applyModelControl",
  "agent.create",
  "agent.updateConfig",
]);

function failure(errorCode: BridgeErrorCode, error: string): BridgeFailure {
  return { ok: false, errorCode, error };
}

function success(payload: Record<string, unknown>): BridgeSuccess {
  return { ok: true, ...payload };
}

function emit(value: BridgeSuccess | BridgeFailure): void {
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
      throw new Error('runtimeInstanceKey must use the form "project:userId"');
    }
    return {
      project: runtimeInstanceKey.slice(0, separator),
      userId: runtimeInstanceKey.slice(separator + 1),
    };
  }

  throw new Error('Missing project/userId or runtimeInstanceKey');
}

function parseLlmProvider(payload: Record<string, unknown>): LlmProvider {
  const provider = asString(payload.llm) ?? asString(payload.provider);
  if (provider === "gemini" || provider === "anthropic" || provider === "openai-compat") {
    return provider;
  }
  throw new Error('llm/provider must be one of: gemini, anthropic, openai-compat');
}

function parseApiKey(payload: Record<string, unknown>): string {
  const apiKey = asString(payload.apiKey) ?? asString(payload.secretValue) ?? asString(payload.key);
  if (!apiKey || !apiKey.trim()) {
    throw new Error("apiKey/secretValue is required");
  }
  return apiKey;
}

async function bridgeInstanceCreate(payload: Record<string, unknown>): Promise<BridgeSuccess> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  let context = asStringRecord(payload.context);
  const displayName = asString(payload.displayName);
  if (displayName && !context?.displayName) {
    context = { ...(context ?? {}), displayName };
  }

  const created = await spawn({
    project,
    userId,
    context: context && Object.keys(context).length > 0 ? context : undefined,
    autoStart: payload.autoStart === false || payload.noStart === true ? false : true,
    quiet: true,
  });

  return success({
    port: created.port,
    userId: created.userId,
  });
}

async function getResolvedInstance(project: string, userId: string) {
  const resolved = await resolveProjectName(project);
  const instance = await getInstance(resolved.name, userId);
  return { resolved, instance };
}

async function requireInstance(project: string, userId: string): Promise<BridgeFailure | null> {
  const { resolved, instance } = await getResolvedInstance(project, userId);
  if (!instance) {
    return failure("runtime-missing", `Instance for user "${userId}" not found in "${resolved.name}"`);
  }
  return null;
}

async function bridgeInstanceStart(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  const unavailable = await requireInstance(project, userId);
  if (unavailable) return unavailable;
  const started = await upInstance(project, userId, { quiet: true });
  return success({ port: started.port, runtimeState: "running" });
}

async function bridgeInstanceStop(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  const unavailable = await requireInstance(project, userId);
  if (unavailable) return unavailable;
  await downInstance(project, userId, { quiet: true });
  return success({ runtimeState: "stopped" });
}

async function bridgeInstanceRestart(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  const unavailable = await requireInstance(project, userId);
  if (unavailable) return unavailable;
  await downInstance(project, userId, { quiet: true });
  await upInstance(project, userId, { quiet: true });
  return success({ runtimeState: "running" });
}

async function bridgeInstanceDelete(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  const unavailable = await requireInstance(project, userId);
  if (unavailable) return unavailable;
  await despawn(project, userId, { quiet: true });
  return success({});
}

async function bridgeInstanceSync(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  const { resolved, instance } = await getResolvedInstance(project, userId);
  if (!instance) {
    return failure("runtime-missing", `Instance for user "${userId}" not found in "${resolved.name}"`);
  }
  const status = await getInstanceRuntimeStatus(project, userId);
  return success({
    runtimeState: status.status,
    composePath: status.composePath,
    composeProject: status.composeProject,
  });
}

async function bridgeInstanceApplyModelControl(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  validateName(userId, "user ID");
  const { resolved, instance } = await getResolvedInstance(project, userId);
  if (!instance) {
    return failure("runtime-missing", `Instance for user "${userId}" not found in "${resolved.name}"`);
  }
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

  return success({
    runtimeState,
    restarted,
    composePath: previousStatus.composePath,
    composeProject: previousStatus.composeProject,
  });
}

async function bridgeAgentCreate(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const agentSlug = asString(payload.agentSlug) ?? asString(payload.agentId) ?? asString(payload.slug);
  if (!agentSlug) {
    throw new Error("agentSlug is required");
  }
  validateName(userId, "user ID");
  validateName(agentSlug, "agent slug");

  const resolved = await resolveProjectName(project);
  const config = await readProjectConfig(resolved.entry.path);
  const { runtime } = resolveRuntimeConfig(config, resolved.entry);
  const instDir = instanceDir(resolved.entry.path, userId);
  const workspaceDir = join(instDir, runtime.runtimeDirName, "workspace");
  const agentDir = join(workspaceDir, "agents", agentSlug);
  const configPath = join(agentDir, "agent.config.json");

  if (!await Bun.file(workspaceDir).exists()) {
    return failure("runtime-missing", "未找到对应实例的 workspace。");
  }
  if (await Bun.file(configPath).exists()) {
    return failure("runtime-conflict", "运行时中已经存在同名 Agent 配置。") as BridgeFailure;
  }

  await mkdir(agentDir, { recursive: true });
  await copyTemplateFiles(templateDir(resolved.entry.path), agentDir);

  const templatePath = join(templateDir(resolved.entry.path), "USER.template.md");
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

  return success({ runtimeAgentKey: `${userId}:${agentSlug}` });
}

async function bridgeAgentUpdateConfig(payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  const { project, userId } = parseRuntimeInstanceKey(payload);
  const agentSlug = asString(payload.agentSlug) ?? asString(payload.agentId) ?? asString(payload.slug);
  if (!agentSlug) {
    throw new Error("agentSlug is required");
  }
  validateName(userId, "user ID");
  validateName(agentSlug, "agent slug");

  const resolved = await resolveProjectName(project);
  const config = await readProjectConfig(resolved.entry.path);
  const { runtime } = resolveRuntimeConfig(config, resolved.entry);
  const instDir = instanceDir(resolved.entry.path, userId);
  const configPath = join(instDir, runtime.runtimeDirName, "workspace", "agents", agentSlug, "agent.config.json");
  const file = Bun.file(configPath);

  if (!await file.exists()) {
    return failure("runtime-missing", "未找到可更新配置的 Agent 工作区。") as BridgeFailure;
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

  return success({ runtimeAgentKey: `${userId}:${agentSlug}` });
}

async function dispatch(operation: string, payload: Record<string, unknown>): Promise<BridgeSuccess | BridgeFailure> {
  if (!INSTANCE_OPERATIONS.has(operation)) {
    return failure("invalid-operation", `Unsupported bridge operation: ${operation}`);
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
      case "instance.applyModelControl":
        return await bridgeInstanceApplyModelControl(payload);
      case "agent.create":
        return await bridgeAgentCreate(payload);
      case "agent.updateConfig":
        return await bridgeAgentUpdateConfig(payload);
      default:
        return failure("invalid-operation", `Unsupported bridge operation: ${operation}`);
    }
  } catch (error) {
    return failure("runtime-command-failed", error instanceof Error ? error.message : String(error));
  }
}

export async function bridgeCommand(args: string[]): Promise<void> {
  const operation = args[0];
  if (!operation) {
    emit(failure("invalid-operation", "Missing bridge operation"));
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = await readPayload(args);
  } catch (error) {
    emit(failure("invalid-payload", error instanceof Error ? error.message : String(error)));
    return;
  }

  const result = await dispatch(operation, payload);
  emit(result);
}
