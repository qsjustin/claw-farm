import { join } from "node:path";
import type { RuntimeType } from "../runtimes/interface.ts";
import { buildSidecarAttachRuntimeMount } from "./backup-bundle.ts";

export interface SidecarAttachPoint {
  providerCode: string;
  sidecarCode: string;
  configDir: string;
  runtimeHandle: string;
  healthEndpoint: string;
  runtimeMountPath: string;
}

function providerEnvKey(providerCode: string): string {
  return providerCode.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

export function resolveSidecarAttachPoint(input: {
  workspaceRoot: string;
  runtimeWorkspaceSlug: string;
  providerCode: string;
  runtimeType: RuntimeType;
  sidecarCode?: string;
  baseUrl?: string;
}): SidecarAttachPoint {
  const sidecarCode = input.sidecarCode ?? input.providerCode;
  const healthBase =
    input.baseUrl?.replace(/\/$/, "") ??
    `\${${providerEnvKey(input.providerCode)}_SIDECAR_URL}`;

  return {
    providerCode: input.providerCode,
    sidecarCode,
    configDir: join(input.workspaceRoot, "runtime", `sidecar-${input.providerCode}`),
    runtimeHandle: `${input.runtimeWorkspaceSlug}:${sidecarCode}`,
    healthEndpoint: `${healthBase}/healthz`,
    runtimeMountPath: buildSidecarAttachRuntimeMount(input.runtimeType, input.providerCode),
  };
}
