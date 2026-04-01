import { join } from "node:path";
import { chmod } from "node:fs/promises";

import type { RuntimeType, ProxyMode, AgentRuntime } from "../runtimes/interface.ts";
import { getRuntime } from "../runtimes/index.ts";
import type { ProjectEntry } from "./registry.ts";

export type LlmProvider = "gemini" | "anthropic" | "openai-compat";

export interface ClawFarmConfig {
  name: string;
  processor: "builtin" | "mem0";
  port: number;
  createdAt: string;
  multiInstance?: boolean;
  llm?: LlmProvider;
  runtime?: RuntimeType;
  proxyMode?: ProxyMode;
}

/**
 * Resolve runtime type, runtime instance, and proxy mode from config + registry entry.
 * Centralises the repeated `config?.runtime ?? entry.runtime ?? "openclaw"` pattern.
 */
export function resolveRuntimeConfig(
  config: ClawFarmConfig | null,
  entry: Pick<ProjectEntry, "runtime">,
): { runtimeType: RuntimeType; runtime: AgentRuntime; proxyMode: ProxyMode } {
  const runtimeType: RuntimeType = config?.runtime ?? entry.runtime ?? "openclaw";
  const runtime = getRuntime(runtimeType);
  const proxyMode: ProxyMode = config?.proxyMode ?? runtime.defaultProxyMode;
  return { runtimeType, runtime, proxyMode };
}

/**
 * Generate .env.example content based on LLM provider and processor.
 * The selected provider's keys are uncommented; others are commented out.
 */
export function envExampleTemplate(
  llm: LlmProvider = "gemini",
  processor: "builtin" | "mem0" = "builtin",
): string {
  const lines: string[] = [
    `# LLM Provider: gemini | anthropic | openai-compat`,
    `LLM_PROVIDER=${llm}`,
    ``,
  ];

  if (llm === "gemini") {
    lines.push(`GEMINI_API_KEY=`);
    lines.push(`# ANTHROPIC_API_KEY=`);
    lines.push(`# OPENAI_API_KEY=`);
    lines.push(`# OPENAI_COMPAT_BASE_URL=`);
  } else if (llm === "anthropic") {
    lines.push(`# GEMINI_API_KEY=`);
    lines.push(`ANTHROPIC_API_KEY=`);
    lines.push(`# OPENAI_API_KEY=`);
    lines.push(`# OPENAI_COMPAT_BASE_URL=`);
  } else {
    lines.push(`# GEMINI_API_KEY=`);
    lines.push(`# ANTHROPIC_API_KEY=`);
    lines.push(`OPENAI_API_KEY=`);
    lines.push(`OPENAI_COMPAT_BASE_URL=`);
  }

  if (processor === "mem0") {
    lines.push(``);
    lines.push(`MEM0_API_KEY=`);
  }

  lines.push(``);
  return lines.join("\n");
}

export async function writeProjectConfig(
  projectDir: string,
  config: ClawFarmConfig,
): Promise<void> {
  const configPath = join(projectDir, ".claw-farm.json");
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
  await chmod(configPath, 0o600);
}

export async function readProjectConfig(
  projectDir: string,
): Promise<ClawFarmConfig | null> {
  try {
    const raw = await Bun.file(join(projectDir, ".claw-farm.json")).text();
    return JSON.parse(raw) as ClawFarmConfig;
  } catch {
    return null;
  }
}

/**
 * Deep merge two objects. `override` values take priority over `base`.
 * Arrays are replaced, not concatenated.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overVal = override[key];
    if (
      overVal !== null &&
      typeof overVal === "object" &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      result[key] = overVal;
    }
  }
  return result;
}

/**
 * Strip JS-style comments from a JSON-like string so JSON.parse can handle it.
 * Handles // line comments and /* block comments *\/ outside of strings.
 */
function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    // String literal — pass through unchanged
    if (text[i] === '"') {
      result += '"';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          result += text[i] + (text[i + 1] ?? "");
          i += 2;
        } else {
          result += text[i];
          i++;
        }
      }
      if (i < text.length) {
        result += '"';
        i++;
      }
    } else if (text[i] === "/" && text[i + 1] === "/") {
      // Line comment — skip to end of line
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      // Block comment — skip to */
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

/**
 * Merge claw-farm template config with existing user config.
 * Template provides the base, user's existing config overrides on top.
 * This preserves user-specific settings (gateway.auth, controlUi, etc.)
 * while updating claw-farm managed fields (agents, models, env).
 */
export function mergeOpenclawConfig(
  templateJson: string,
  existingJson: string,
): string {
  try {
    const template = JSON.parse(stripJsonComments(templateJson)) as Record<string, unknown>;
    const existing = JSON.parse(stripJsonComments(existingJson)) as Record<string, unknown>;
    // Base merge: template as base, existing overrides (preserves user keys)
    const merged = deepMerge(template, existing);
    // Re-apply template fields that claw-farm must control
    // (user should not accidentally keep stale model/provider config)
    merged.agents = deepMerge(
      (existing.agents ?? {}) as Record<string, unknown>,
      (template.agents ?? {}) as Record<string, unknown>,
    );
    merged.models = deepMerge(
      (existing.models ?? {}) as Record<string, unknown>,
      (template.models ?? {}) as Record<string, unknown>,
    );
    // Merge env: template as base, user additions preserved,
    // but force-apply API key sentinels from template (security: must route through proxy)
    const mergedEnv = deepMerge(
      (template.env ?? {}) as Record<string, unknown>,
      (existing.env ?? {}) as Record<string, unknown>,
    );
    const templateEnv = (template.env ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(templateEnv)) {
      if (key.endsWith("_API_KEY")) {
        mergedEnv[key] = templateEnv[key]; // force "proxied" sentinel
      }
    }
    merged.env = mergedEnv;
    // Ensure every provider has a models array (OpenClaw requires it)
    const providers = (merged.models as Record<string, unknown>)?.providers as Record<string, Record<string, unknown>> | undefined;
    if (providers) {
      for (const key of Object.keys(providers)) {
        if (providers[key] && !Array.isArray(providers[key].models)) {
          providers[key].models = [];
        }
      }
    }
    // Ensure controlUi.enabled from template is applied, but preserve user's
    // other controlUi settings (allowedOrigins, dangerouslyDisableDeviceAuth, etc.)
    const mergedGateway = (merged.gateway ?? {}) as Record<string, unknown>;
    const templateControlUi = ((template.gateway ?? {}) as Record<string, unknown>).controlUi as Record<string, unknown> | undefined;
    if (templateControlUi) {
      const userControlUi = (mergedGateway.controlUi ?? {}) as Record<string, unknown>;
      mergedGateway.controlUi = { ...userControlUi, enabled: templateControlUi.enabled };
    }
    // Remove root-level controlUi if present (OpenClaw reads gateway.controlUi)
    delete merged.controlUi;
    return JSON.stringify(merged, null, 2) + "\n";
  } catch {
    // If existing config is unparseable, just use template
    return templateJson;
  }
}
