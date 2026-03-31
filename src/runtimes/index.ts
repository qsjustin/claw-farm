/**
 * Runtime factory.
 * Returns the appropriate AgentRuntime implementation based on type.
 */

import type { AgentRuntime, RuntimeType } from "./interface.ts";
import { openclawRuntime } from "./openclaw.ts";
import { picoClawRuntime } from "./picoclaw.ts";

const runtimes: Record<RuntimeType, AgentRuntime> = {
  openclaw: openclawRuntime,
  picoclaw: picoClawRuntime,
};

/**
 * Get runtime by type. Defaults to "openclaw" for backward compatibility
 * (existing projects without a runtime field).
 */
export function getRuntime(type?: RuntimeType): AgentRuntime {
  const resolved = type ?? "openclaw";
  const runtime = runtimes[resolved];
  if (!runtime) {
    throw new Error(
      `Unknown runtime: "${resolved}". Available: ${Object.keys(runtimes).join(", ")}`,
    );
  }
  return runtime;
}

export type { AgentRuntime, RuntimeType, ProxyMode } from "./interface.ts";
