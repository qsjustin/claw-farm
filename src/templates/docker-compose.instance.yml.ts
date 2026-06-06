import type { ProxyMode } from "../runtimes/interface.ts";
import { safeYamlIdentifier } from "../lib/validate.ts";

export interface InstanceComposeOptions {
  projectName: string;
  userId: string;
  port: number;
  proxyMode?: ProxyMode;
  instanceHostDir?: string;
  /**
   * #159B: Enable per-instance weixin sidecar.
   * When enabled, a weixin-sidecar service is added to the instance compose.
   * The sidecar consumes WEIXIN_BINDING_TOKEN from the per-instance env file.
   */
  enableWeixinSidecar?: boolean;
  /**
   * #159B: Filename for the per-instance weixin env file (relative to instance dir).
   * Token provisioning writes WEIXIN_BINDING_TOKEN here.
   * Default: ".env.weixin"
   */
  weixinEnvFile?: string;
  /**
   * #159B: Per-instance weixin sidecar port (default: 8787).
   * Each instance gets a unique port to avoid conflicts.
   */
  weixinSidecarPort?: number;
}

/**
 * Per-instance docker-compose template for multi-instance projects.
 * Shared template files mounted read-only, per-instance data mounted read-write.
 *
 * Backward compatible: calling with positional args behaves identically to before.
 */
export function instanceComposeTemplate(
  projectName: string,
  userId: string,
  port: number,
  proxyMode: ProxyMode = "per-instance",
  instanceHostDir?: string,
): string {
  return buildInstanceCompose({
    projectName,
    userId,
    port,
    proxyMode,
    instanceHostDir,
    enableWeixinSidecar: false,
  });
}

/**
 * #159B: Extended per-instance compose builder with weixin sidecar support.
 *
 * The weixin sidecar:
 * - Uses the same claw-sidecar-weixin image as the shared workspace sidecar
 * - Consumes WEIXIN_BINDING_TOKEN from a per-instance env file (REAL consumer)
 * - Uses compose bridge network (not host) for per-instance isolation
 * - Gets a unique port per instance to avoid conflicts
 * - Connects to shared services via host.docker.internal
 */
export function buildInstanceCompose(opts: InstanceComposeOptions): string {
  const {
    projectName,
    userId,
    port,
    proxyMode = "per-instance",
    instanceHostDir,
    enableWeixinSidecar = false,
    weixinEnvFile = ".env.weixin",
    weixinSidecarPort = 8787,
  } = opts;

  safeYamlIdentifier(projectName, "project name");
  safeYamlIdentifier(userId, "user ID");
  const containerPrefix = `${projectName}-${userId}`;
  const hasProxy = proxyMode !== "none";
  const openclawMountSource = instanceHostDir ? `${instanceHostDir}/openclaw` : "./openclaw";

  // ─── api-proxy (conditional) ──────────────────────────────────────────────
  const apiProxyService = hasProxy ? `  api-proxy:
    container_name: ${containerPrefix}-api-proxy
    build: ../../api-proxy
    expose:
      - "8080"
    env_file:
      - ./.env.model
    environment:
      AUDIT_LOG_PATH: /logs/api-proxy-audit.jsonl
      MAX_PROMPT_SIZE_MB: 5
      PII_MODE: redact
    volumes:
      - ./logs:/logs
    networks:
      - proxy-net
    read_only: true
    tmpfs:
      - /tmp:size=50M
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

` : "";

  // ─── #159B: weixin-sidecar (conditional) ─────────────────────────────────
  //
  // REAL consumer: token comes ONLY from env_file — no environment override.
  // Network: bridge network (not host) for per-instance isolation.
  // Port: unique per instance to avoid conflicts.
  //
  // The sidecar connects to shared services (sidecar-gateway, claw-bay-api)
  // via host.docker.internal, which resolves to the host's loopback from
  // within the container.

  const weixinSidecarService = enableWeixinSidecar ? `  weixin-sidecar:
    container_name: ${containerPrefix}-weixin
    build: ../../claw-sidecar-weixin
    env_file:
      - ./${weixinEnvFile}
      - ./instance.env
    environment:
      SIDECAR_GATEWAY_URL: http://host.docker.internal:3002
      GATEWAY_INTERNAL_TOKEN: \${GATEWAY_INTERNAL_TOKEN:-gateway-dev-token}
      SIDECAR_CLAW_BAY_API_URL: http://host.docker.internal:3001
      WEIXIN_ENABLE_ILINK_TRANSPORT: \${WEIXIN_ENABLE_ILINK_TRANSPORT:-false}
    ports:
      - "127.0.0.1:${weixinSidecarPort}:8787"
    volumes:
      - ${openclawMountSource}/workspace/runtime/sidecar-weixin:/data
    networks:
      - sidecar-net
    read_only: true
    tmpfs:
      - /tmp:size=50M
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped

` : "";

  // ─── openclaw-gateway (always present) ────────────────────────────────────
  const openclawGatewayService = `  openclaw-gateway:
    container_name: ${containerPrefix}-openclaw
    image: ghcr.io/openclaw/openclaw:latest
    ports:
      - "127.0.0.1:${port}:18789"
    volumes:
      # Directory mount — OpenClaw needs atomic rename for config updates
      # Template files (SOUL.md, AGENTS.md, skills/) are copied into openclaw/workspace/
      # at spawn/upgrade time instead of overlay mounts (Docker Desktop compatibility)
      # Sidecar attach points live under workspace/runtime/sidecar-* and are
      # available through this same bind mount without extra per-provider volumes.
      - ${openclawMountSource}:/home/node/.openclaw
    env_file:
      - ./instance.env
      - ./.env.model
    environment:
${hasProxy ? `      OPENCLAW_API_PROXY: http://api-proxy:8080` : `      # OPENCLAW_API_PROXY: not set (proxyMode: none)`}
      OPENCLAW_SANDBOX: 1
      OPENCLAW_AUDIT_LOG: /home/node/.openclaw/logs/audit.jsonl
      OPENCLAW_SIDECAR_ATTACH_ROOT: /home/node/.openclaw/workspace/runtime
      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN:?Set OPENCLAW_GATEWAY_TOKEN for OpenClaw HTTP access}
${hasProxy ? `    networks:
      - proxy-net` : ""}
    read_only: true
    tmpfs:
      - /tmp:size=100M
      - /home/node/.cache:size=200M
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: "1.0"
        reservations:
          memory: 256M
${hasProxy ? `    depends_on:
      api-proxy:
        condition: service_healthy` : ""}
    restart: unless-stopped
`;

  // ─── networks ─────────────────────────────────────────────────────────────
  // sidecar-net is always present when weixin sidecar is enabled.
  // proxy-net is present when proxy mode is enabled.
  const networks: string[] = [];
  if (hasProxy) {
    networks.push(`  proxy-net:
    # internal: false — allows port binding + outbound for api-proxy
    # Production deploys use cloud:compose with nginx + full network isolation`);
  }
  if (enableWeixinSidecar) {
    networks.push(`  sidecar-net:
    # Bridge network for per-instance weixin sidecar isolation`);
  }
  const networksSection = networks.length > 0 ? `\nnetworks:\n${networks.join("\n")}\n` : "";

  return `# Generated by claw-farm — ${projectName} instance: ${userId}
services:
${apiProxyService}${weixinSidecarService}${openclawGatewayService}${networksSection}
`;
}
