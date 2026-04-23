import { validateName } from "./registry.ts";
import type { InstanceRuntimeState } from "./api.ts";

export type BridgeRuntimeState = InstanceRuntimeState | "deleted";

export type BridgeErrorCode =
  | "adapter-unavailable"
  | "invalid-operation"
  | "invalid-payload"
  | "runtime-missing"
  | "runtime-conflict"
  | "runtime-command-failed"
  | "unknown";

export interface BridgeResponseBase {
  action: string;
  message: string;
  observedAt: string;
  runtimeState?: BridgeRuntimeState;
  runtimeInstanceKey?: string;
  runtimeWorkspaceSlug?: string;
  metadata?: Record<string, unknown>;
}

export interface BridgeSuccess extends BridgeResponseBase {
  ok: true;
  [key: string]: unknown;
}

export interface BridgeFailure extends BridgeResponseBase {
  ok: false;
  error: string;
  errorCode: BridgeErrorCode;
  retryable: boolean;
  [key: string]: unknown;
}

export type BridgeResponse = BridgeSuccess | BridgeFailure;

export interface BridgeResponseContext {
  project?: string;
  userId?: string;
}

function withRuntimeContext(context?: BridgeResponseContext): Pick<BridgeResponseBase, "runtimeInstanceKey" | "runtimeWorkspaceSlug"> {
  if (!context?.project || !context.userId) {
    return {};
  }

  return {
    runtimeInstanceKey: buildRuntimeInstanceKey(context.project, context.userId),
    runtimeWorkspaceSlug: buildRuntimeWorkspaceSlug(context.userId),
  };
}

function defaultRetryable(errorCode: BridgeErrorCode): boolean {
  return errorCode === "adapter-unavailable" || errorCode === "runtime-command-failed" || errorCode === "unknown";
}

export function buildRuntimeInstanceKey(project: string, userId: string): string {
  validateName(project, "project name");
  validateName(userId, "user ID");
  return `${project}:${userId}`;
}

export function buildRuntimeWorkspaceSlug(userId: string): string {
  validateName(userId, "user ID");
  return userId;
}

export function createBridgeSuccess(input: BridgeResponseBase & BridgeResponseContext & { extra?: Record<string, unknown> }): BridgeSuccess {
  const { project, userId, extra, ...base } = input;
  return {
    ok: true,
    ...base,
    ...withRuntimeContext({ project, userId }),
    ...(extra ?? {}),
  };
}

export function createBridgeFailure(
  input: BridgeResponseBase & BridgeResponseContext & {
    errorCode: BridgeErrorCode;
    retryable?: boolean;
    extra?: Record<string, unknown>;
  },
): BridgeFailure {
  const { project, userId, errorCode, retryable, extra, ...base } = input;
  return {
    ok: false,
    errorCode,
    retryable: retryable ?? defaultRetryable(errorCode),
    error: base.message,
    ...base,
    ...withRuntimeContext({ project, userId }),
    ...(extra ?? {}),
  };
}
