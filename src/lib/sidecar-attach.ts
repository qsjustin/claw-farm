import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeType } from "../runtimes/interface.ts";
import { buildSidecarAttachRuntimeMount } from "./backup-bundle.ts";
import type { WorkspaceLayout } from "./workspace-layout.ts";

export interface SidecarAttachPoint {
  providerCode: string;
  sidecarCode: string;
  configDir: string;
  runtimeHandle: string;
  healthEndpoint: string;
  runtimeMountPath: string;
}

export const DEFAULT_SIDECAR_ATTACH_PROVIDERS = [
  { providerCode: "weixin", sidecarCode: "weixin-auth-sidecar" },
] as const;

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

function attachDescriptor(attach: SidecarAttachPoint): string {
  return `${JSON.stringify({
    providerCode: attach.providerCode,
    sidecarCode: attach.sidecarCode,
    runtimeHandle: attach.runtimeHandle,
    healthEndpoint: attach.healthEndpoint,
    runtimeMountPath: attach.runtimeMountPath,
  }, null, 2)}\n`;
}

export async function ensureSidecarAttachPoint(attach: SidecarAttachPoint): Promise<void> {
  await mkdir(attach.configDir, { recursive: true, mode: 0o755 });
  await writeFile(join(attach.configDir, "attach-point.json"), attachDescriptor(attach), "utf8");
}

export async function ensureDefaultSidecarAttachPoints(input: {
  layout: WorkspaceLayout;
  runtimeType: RuntimeType;
}): Promise<SidecarAttachPoint[]> {
  const attachPoints = DEFAULT_SIDECAR_ATTACH_PROVIDERS.map((provider) =>
    resolveSidecarAttachPoint({
      workspaceRoot: input.layout.workspaceRoot,
      runtimeWorkspaceSlug: input.layout.runtimeWorkspaceSlug,
      providerCode: provider.providerCode,
      sidecarCode: provider.sidecarCode,
      runtimeType: input.runtimeType,
    }),
  );

  await Promise.all(attachPoints.map((attach) => ensureSidecarAttachPoint(attach)));
  return attachPoints;
}
