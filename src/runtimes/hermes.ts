/**
 * Hermes runtime implementation.
 * Hermes runs as an API server and owns the full /opt/data directory.
 */

import type { AgentRuntime, ProxyMode } from "./interface.ts";
import type { LlmProvider } from "../lib/config.ts";
import {
  hermesComposeTemplate,
  hermesInstanceComposeTemplate,
} from "../templates/docker-compose.hermes.yml.ts";
import { hermesRuntimeConfigTemplate } from "../templates/hermes.runtime.json.ts";

export const hermesRuntime: AgentRuntime = {
  name: "hermes",
  configFileName: ".claw-farm-hermes.json",
  additionalConfigFiles: [],
  containerMountPath: "/opt/data",
  sharedTemplateFiles: ["SOUL.md", "AGENTS.md"],
  gatewayPort: 8642,
  runtimeDirName: "hermes",
  defaultProxyMode: "none",

  composeTemplate(name: string, port: number, proxyMode?: ProxyMode, gatewayAllowAllUsers?: boolean): string {
    return hermesComposeTemplate(name, port, proxyMode ?? this.defaultProxyMode, gatewayAllowAllUsers ?? false);
  },

  instanceComposeTemplate(
    projectName: string,
    userId: string,
    port: number,
    proxyMode: ProxyMode,
    instanceHostDir?: string,
    gatewayAllowAllUsers?: boolean,
  ): string {
    return hermesInstanceComposeTemplate(projectName, userId, port, proxyMode, instanceHostDir, gatewayAllowAllUsers ?? false);
  },

  configTemplate(
    name: string,
    processor: "builtin" | "mem0",
    llm: LlmProvider,
    options?: {
      modelSlug?: string;
      baseUrl?: string | null;
      useProxy?: boolean;
    },
  ): string {
    return hermesRuntimeConfigTemplate(name, processor, llm, options);
  },

  mergeConfig(templateJson: string, existingJson: string): string {
    try {
      const template = JSON.parse(templateJson) as Record<string, unknown>;
      const existing = JSON.parse(existingJson) as Record<string, unknown>;
      const managedKeys = new Set(["llm", "modelSlug", "baseUrl"]);
      const merged: Record<string, unknown> = { ...template, ...existing };
      for (const key of managedKeys) {
        if (Object.prototype.hasOwnProperty.call(template, key)) {
          merged[key] = template[key];
        } else if (Object.prototype.hasOwnProperty.call(merged, key)) {
          delete merged[key];
        }
      }
      return `${JSON.stringify(merged, null, 2)}\n`;
    } catch {
      return existingJson || templateJson;
    }
  },
};
