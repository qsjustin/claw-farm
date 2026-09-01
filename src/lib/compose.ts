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
  /** Suppress compose output and warnings. */
  quiet?: boolean;
  /**
   * Whether a sibling docker-compose.openclaw.override.yml may be merged.
   * Security-sensitive paired runtime operations set this false so an
   * instance-local override cannot replace the verified image or gateway URL.
   */
  allowOverride?: boolean;
  /**
   * After compose up, connect this container to the compose's network.
   * Used for shared proxy mode: connects the api-proxy to each instance's
   * isolated network (hub-and-spoke topology for cross-tenant isolation).
   */
  connectContainer?: { container: string; network: string };
}

export interface DockerNetworkConnectOptions {
  quiet?: boolean;
  required?: boolean;
}

function sanitizeDockerMessage(message: string): string {
  return message
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "[runtime-path]")
    .replace(/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g, "[runtime-path]");
}

async function dockerComposeCommand(): Promise<string[]> {
  const proc = Bun.spawn(["docker", "compose", "version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    return ["docker", "compose"];
  }

  return ["docker-compose"];
}

export async function runCompose(
  projectDir: string,
  action: "up" | "down" | "stop" | "start",
  options?: ComposeOptions,
): Promise<void> {
  const composePath = options?.composePath ?? join(projectDir, COMPOSE_FILENAME);
  const cwd = options?.composePath ? dirname(composePath) : projectDir;
  const quiet = options?.quiet ?? false;

  const args = [...await dockerComposeCommand(), "-f", composePath];

  await appendOverrideFile(args, composePath, options);

  if (options?.projectName) {
    args.push("-p", options.projectName);
  }

  if (action === "up") {
    args.push("up", "-d");
  } else if (action === "down") {
    // On down, disconnect container from network first (best effort)
    if (options?.connectContainer) {
      await dockerNetworkDisconnect(
        options.connectContainer.network,
        options.connectContainer.container,
      );
    }
    args.push("down");
  } else {
    // stop / start — preserve containers and volumes
    args.push(action);
  }

  const proc = Bun.spawn(args, {
    cwd,
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  if (quiet) {
    const stdoutText = new Response(proc.stdout).text();
    const stderrText = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim();
      throw new Error(
        detail
          ? `docker compose ${action} failed with exit code ${exitCode}: ${detail}`
          : `docker compose ${action} failed with exit code ${exitCode}`,
      );
    }
  } else {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`docker compose ${action} failed with exit code ${exitCode}`);
    }
  }

  // After compose up, connect the shared proxy container to this instance's network
  // This creates hub-and-spoke: api-proxy ↔ each instance, but instances cannot reach each other
  if (action === "up" && options?.connectContainer) {
    await dockerNetworkConnect(
      options.connectContainer.network,
      options.connectContainer.container,
      { quiet },
    );
  }
}

/**
 * Run a docker compose command targeting a specific service.
 * #171 Phase 2A-2: Used for sidecar attach/detach — start/stop/rm a single
 * service without affecting the main instance containers.
 *
 * @param projectDir - Instance directory containing the compose file
 * @param action - "up" (create+start), "stop", or "rm" (stop+remove)
 * @param serviceName - Target service name (e.g. "weixin-sidecar")
 * @param options - Compose options (projectName, quiet, etc.)
 */
export async function runComposeService(
  projectDir: string,
  action: "up" | "stop" | "rm",
  serviceName: string,
  options?: ComposeOptions,
): Promise<void> {
  const composePath = options?.composePath ?? join(projectDir, COMPOSE_FILENAME);
  const cwd = options?.composePath ? dirname(composePath) : projectDir;
  const quiet = options?.quiet ?? false;

  const args = [...await dockerComposeCommand(), "-f", composePath];

  await appendOverrideFile(args, composePath, options);

  if (options?.projectName) {
    args.push("-p", options.projectName);
  }

  if (action === "up") {
    args.push("up", "-d", serviceName);
  } else if (action === "stop") {
    args.push("stop", serviceName);
  } else {
    args.push("rm", "-f", serviceName);
  }

  const proc = Bun.spawn(args, {
    cwd,
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  if (quiet) {
    const stdoutText = new Response(proc.stdout).text();
    const stderrText = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim();
      throw new Error(
        detail
          ? `docker compose ${action} ${serviceName} failed with exit code ${exitCode}: ${detail}`
          : `docker compose ${action} ${serviceName} failed with exit code ${exitCode}`,
      );
    }
  } else {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`docker compose ${action} ${serviceName} failed with exit code ${exitCode}`);
    }
  }
}

async function appendOverrideFile(
  args: string[],
  composePath: string,
  options?: ComposeOptions,
): Promise<void> {
  const overridePath = composePath.replace(".yml", ".override.yml");
  if (!await fileExists(overridePath)) return;
  if (options?.allowOverride === false) {
    throw new Error("instance compose override is not permitted for this security-sensitive operation");
  }
  args.push("-f", overridePath);
}

/**
 * Connect a running container to a Docker network.
 * Used for shared proxy mode: each instance network gets the api-proxy attached.
 */
export async function dockerNetworkConnect(
  network: string,
  container: string,
  options: DockerNetworkConnectOptions = {},
): Promise<void> {
  const proc = Bun.spawn(["docker", "network", "connect", network, container], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = sanitizeDockerMessage(await new Response(proc.stderr).text());
    // Ignore "already connected" errors
    if (stderr.includes("already exists")) {
      return;
    }
    if (options.required) {
      throw new Error(
        `Docker network connect failed for required runtime network "${network}" and container "${container}": ${stderr.trim() || "unknown error"}`,
      );
    }
    if (!options.quiet) {
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

  const args = [...await dockerComposeCommand(), "-f", composePath];
  if (options?.projectName) {
    args.push("-p", options.projectName);
  }
  args.push("ps", "-q");

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
