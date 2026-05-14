import type { LlmProvider } from "../lib/config.ts";

export function hermesRuntimeConfigTemplate(
  name: string,
  processor: "builtin" | "mem0",
  llm: LlmProvider,
): string {
  return `${JSON.stringify({
    managedBy: "claw-farm",
    runtime: "hermes",
    project: name,
    processor,
    llm,
    notes: [
      "Hermes reads its own runtime configuration from /opt/data.",
      "Do not store API keys in this claw-farm metadata file.",
    ],
  }, null, 2)}\n`;
}
