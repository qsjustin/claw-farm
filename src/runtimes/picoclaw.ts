/**
 * picoclaw runtime implementation.
 * Go-based lightweight agent runtime (~20MB vs OpenClaw's ~1.5GB).
 * Uses per-user containers for memory isolation (picoclaw's multi-agent
 * feature is for role-based agents, not per-user isolation).
 */

import type { AgentRuntime, ProxyMode } from "./interface.ts";
import type { LlmProvider } from "../lib/config.ts";
import { picoClawComposeTemplate, picoClawInstanceComposeTemplate, picoClawInstanceSharedProxyComposeTemplate, picoClawProxyComposeTemplate } from "../templates/docker-compose.picoclaw.yml.ts";
import { picoClawConfigTemplate } from "../templates/picoclaw.config.json.ts";
import { deepMerge } from "../lib/config.ts";

export const picoClawRuntime: AgentRuntime = {
  name: "picoclaw",
  configFileName: "config.json",
  additionalConfigFiles: [],
  containerMountPath: "/root/.picoclaw",
  sharedTemplateFiles: ["SOUL.md", "AGENTS.md"],
  gatewayPort: 18790,
  runtimeDirName: "picoclaw",
  defaultProxyMode: "shared",

  composeTemplate(name: string, port: number): string {
    return picoClawComposeTemplate(name, port);
  },

  instanceComposeTemplate(
    projectName: string,
    userId: string,
    port: number,
    proxyMode: ProxyMode,
  ): string {
    if (proxyMode === "shared") {
      return picoClawInstanceSharedProxyComposeTemplate(projectName, userId, port);
    }
    return picoClawInstanceComposeTemplate(projectName, userId, port);
  },

  proxyComposeTemplate(name: string): string {
    return picoClawProxyComposeTemplate(name);
  },

  configTemplate(
    name: string,
    processor: "builtin" | "mem0",
    llm: LlmProvider,
  ): string {
    return picoClawConfigTemplate(name, processor, llm);
  },

  mergeConfig(templateJson: string, existingJson: string): string {
    try {
      const template = JSON.parse(templateJson) as Record<string, unknown>;
      const existing = JSON.parse(existingJson) as Record<string, unknown>;

      // Base merge: template as base, existing overrides
      const merged = deepMerge(template, existing);

      // Force-apply proxy-managed fields
      merged.model_list = template.model_list;
      merged.gateway = deepMerge(
        (existing.gateway ?? {}) as Record<string, unknown>,
        (template.gateway ?? {}) as Record<string, unknown>,
      );

      return JSON.stringify(merged, null, 2) + "\n";
    } catch {
      return templateJson;
    }
  },
};
