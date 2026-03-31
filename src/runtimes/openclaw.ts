/**
 * OpenClaw runtime implementation.
 * Delegates to existing template functions — no behavior change.
 */

import type { AgentRuntime, ProxyMode } from "./interface.ts";
import type { LlmProvider } from "../lib/config.ts";
import { baseComposeTemplate } from "../templates/docker-compose.yml.ts";
import { instanceComposeTemplate } from "../templates/docker-compose.instance.yml.ts";
import { openclawConfigTemplate } from "../templates/openclaw.json.ts";
import { mergeOpenclawConfig } from "../lib/config.ts";

export const openclawRuntime: AgentRuntime = {
  name: "openclaw",
  configFileName: "openclaw.json",
  additionalConfigFiles: ["policy.yaml"],
  containerMountPath: "/home/node/.openclaw",
  sharedTemplateFiles: ["SOUL.md", "AGENTS.md"],
  gatewayPort: 18789,
  runtimeDirName: "openclaw",
  defaultProxyMode: "per-instance",

  composeTemplate(name: string, port: number): string {
    return baseComposeTemplate(name, port);
  },

  instanceComposeTemplate(
    projectName: string,
    userId: string,
    port: number,
    _proxyMode: ProxyMode,
  ): string {
    // OpenClaw always includes api-proxy in instance compose (per-instance is the only mode)
    return instanceComposeTemplate(projectName, userId, port);
  },

  configTemplate(
    name: string,
    processor: "builtin" | "mem0",
    llm: LlmProvider,
  ): string {
    return openclawConfigTemplate(name, processor, llm);
  },

  mergeConfig(templateJson: string, existingJson: string): string {
    return mergeOpenclawConfig(templateJson, existingJson);
  },
};
