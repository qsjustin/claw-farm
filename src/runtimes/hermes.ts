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

  composeTemplate(name: string, port: number, proxyMode?: ProxyMode): string {
    return hermesComposeTemplate(name, port, proxyMode ?? this.defaultProxyMode);
  },

  instanceComposeTemplate(
    projectName: string,
    userId: string,
    port: number,
    proxyMode: ProxyMode,
    instanceHostDir?: string,
  ): string {
    return hermesInstanceComposeTemplate(projectName, userId, port, proxyMode, instanceHostDir);
  },

  configTemplate(
    name: string,
    processor: "builtin" | "mem0",
    llm: LlmProvider,
  ): string {
    return hermesRuntimeConfigTemplate(name, processor, llm);
  },

  mergeConfig(templateJson: string, existingJson: string): string {
    try {
      const template = JSON.parse(templateJson) as Record<string, unknown>;
      const existing = JSON.parse(existingJson) as Record<string, unknown>;
      return `${JSON.stringify({ ...template, ...existing }, null, 2)}\n`;
    } catch {
      return existingJson || templateJson;
    }
  },
};
