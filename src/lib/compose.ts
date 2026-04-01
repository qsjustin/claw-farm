import { join, dirname } from "node:path";
import type { RuntimeType, ProxyMode } from "../runtimes/interface.ts";
import { fileExists } from "./fs-utils.ts";

/** Canonical claw-farm compose filename. Used for all single-instance and instance compose files. */
export const COMPOSE_FILENAME = "docker-compose.openclaw.yml";

export interface ComposeOptions {
  /** Override compose file path (default: docker-compose.openclaw.yml in projectDir) */
  composePath?: string;
  /** Docker compose project name (-p flag) for container isolation */
  projectName?: string;
  /**
   * After compose up, connect this container to the compose's network.
   * Used for shared proxy mode: connects the api-proxy to each instance's
   * isolated network (hub-and-spoke topology for cross-tenant isolation).
   */
  connectContainer?: { container: string; network: string };
}

export async function runCompose(
  projectDir: string,
  action: "up" | "down",
  options?: ComposeOptions,
): Promise<void> {
  const composePath = options?.composePath ?? join(projectDir, COMPOSE_FILENAME);
  const cwd = options?.composePath ? dirname(composePath) : projectDir;

  const args = ["docker", "compose", "-f", composePath];

  // Auto-load override file if it exists (user customizations survive upgrade)
  const overridePath = composePath.replace(".yml", ".override.yml");
  if (await fileExists(overridePath)) {
    args.push("-f", overridePath);
  }

  if (options?.projectName) {
    args.push("-p", options.projectName);
  }

  if (action === "up") {
    args.push("up", "-d");
  } else {
    // On down, disconnect container from network first (best effort)
    if (options?.connectContainer) {
      await dockerNetworkDisconnect(
        options.connectContainer.network,
        options.connectContainer.container,
      );
    }
    args.push("down");
  }

  const proc = Bun.spawn(args, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose ${action} failed with exit code ${exitCode}`);
  }

  // After compose up, connect the shared proxy container to this instance's network
  // This creates hub-and-spoke: api-proxy ↔ each instance, but instances cannot reach each other
  if (action === "up" && options?.connectContainer) {
    await dockerNetworkConnect(
      options.connectContainer.network,
      options.connectContainer.container,
    );
  }
}

/**
 * Connect a running container to a Docker network.
 * Used for shared proxy mode: each instance network gets the api-proxy attached.
 */
async function dockerNetworkConnect(network: string, container: string): Promise<void> {
  const proc = Bun.spawn(["docker", "network", "connect", network, container], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    // Ignore "already connected" errors
    if (!stderr.includes("already exists")) {
      console.warn(`⚠ Could not connect ${container} to ${network}: ${stderr.trim()}`);
    }
  }
}

/** Disconnect a container from a Docker network (best effort, ignore errors). */
async function dockerNetworkDisconnect(network: string, container: string): Promise<void> {
  const proc = Bun.spawn(["docker", "network", "disconnect", network, container], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  // Best effort — ignore errors (container may already be disconnected)
}

/** Build connectContainer option for shared proxy mode (hub-and-spoke). */
export function sharedProxyConnect(
  projectName: string,
  userId: string,
  runtimeType: RuntimeType,
  proxyMode: ProxyMode,
): { container: string; network: string } | undefined {
  if (proxyMode === "shared" && runtimeType !== "openclaw") {
    return {
      container: `${projectName}-api-proxy`,
      network: `${projectName}-${userId}_instance-net`,
    };
  }
  return undefined;
}

export async function getComposeStatus(
  projectDir: string,
  options?: ComposeOptions,
): Promise<"running" | "stopped" | "unknown"> {
  const composePath = options?.composePath ?? join(projectDir, COMPOSE_FILENAME);
  const cwd = options?.composePath ? dirname(composePath) : projectDir;

  const args = ["docker", "compose", "-f", composePath];
  if (options?.projectName) {
    args.push("-p", options.projectName);
  }
  args.push("ps", "--format", "json");

  try {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return "unknown";
    if (!output.trim()) return "stopped";
    return "running";
  } catch {
    return "unknown";
  }
}
