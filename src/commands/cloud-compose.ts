import { resolve, relative, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadRegistry, findPositionalArg } from "../lib/registry.ts";
import { readProjectConfig, resolveRuntimeConfig } from "../lib/config.ts";
import { portRange } from "../lib/ports.ts";
import { safeYamlIdentifier } from "../lib/validate.ts";
import {
  nginxProxyTemplate,
  nginxDockerfileTemplate,
} from "../templates/nginx-proxy.ts";

export async function cloudComposeCommand(args: string[]): Promise<void> {
  const reg = await loadRegistry();
  const names = Object.keys(reg.projects);

  if (names.length === 0) {
    console.log("No projects registered. Run: claw-farm init <name>");
    return;
  }

  const outFile =
    findPositionalArg(args) ?? "docker-compose.cloud.yml";

  // Output path validation — must stay within cwd
  const resolved = resolve(process.cwd(), outFile);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..")) {
    console.error("Output file must be within current directory");
    process.exit(1);
  }

  let services = "";
  const usedNetworks = new Set<string>();
  const nginxProjects: Array<{
    name: string;
    port: number;
    containerName: string;
    proxyMode: string;
  }> = [];

  // Shared networks for cloud isolation
  usedNetworks.add("public-net"); // nginx ↔ host (port binding)
  // egress-net is added conditionally per-project when hasProxy=true

  for (const name of names) {
    safeYamlIdentifier(name, "project name");
    const entry = reg.projects[name];
    const config = await readProjectConfig(entry.path);
    const processor = config?.processor ?? entry.processor;
    const { runtimeType, proxyMode } = resolveRuntimeConfig(config, entry);
    const ports = portRange(entry.port);
    const proxyNet = `${name}-proxy-net`;
    const agentNet = `${name}-agent-net`;
    const hasProxy = proxyMode !== "none";
    // proxy-net for projects with proxy; agent-net (internal) for proxyMode=none
    if (hasProxy) {
      usedNetworks.add(proxyNet);
    } else {
      usedNetworks.add(agentNet);
    }
    const containerName = runtimeType === "picoclaw" ? `${name}-picoclaw` : `${name}-openclaw`;
    const gatewayPort = runtimeType === "picoclaw" ? 18790 : ports.openclaw;
    nginxProjects.push({
      name,
      port: gatewayPort,
      containerName,
      proxyMode,
    });

    // API Proxy: proxy-net (internal, ↔ agent) + egress-net (outbound to LLM API)
    // Skip when proxyMode=none — project handles proxying internally
    if (hasProxy) {
      usedNetworks.add("egress-net");
    }
    if (hasProxy) services += `  ${name}-api-proxy:
    build: ./${name}/api-proxy
    expose:
      - "8080"
    environment:
      LLM_PROVIDER: \${LLM_PROVIDER:-gemini}
      GEMINI_API_KEY: \${GEMINI_API_KEY:-}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      OPENAI_COMPAT_BASE_URL: \${OPENAI_COMPAT_BASE_URL:-}
      AUDIT_LOG_PATH: /logs/api-proxy-audit.jsonl
      MAX_PROMPT_SIZE_MB: 5
      PII_MODE: redact
    volumes:
      - ./${name}/logs:/logs
    networks:
      - ${proxyNet}
      - egress-net
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

`;

    // Agent gateway: internal network only — NO internet, NO port binding
    // nginx proxies to it via proxy-net (with proxy) or agent-net (without proxy)
    const agentNetworks = hasProxy ? [proxyNet] : [agentNet];
    const agentDeps: string[] = hasProxy
      ? [`      ${name}-api-proxy:\n        condition: service_healthy`]
      : [];
    if (processor === "mem0") {
      const frontendNet = `${name}-frontend`;
      agentNetworks.push(frontendNet);
      agentDeps.push(`      ${name}-mem0:\n        condition: service_healthy`);
    }

    if (runtimeType === "picoclaw") {
      services += `  ${name}-picoclaw:
    image: ghcr.io/sipeed/picoclaw:latest
    expose:
      - "18790"
    volumes:
      - ./${name}/picoclaw:/root/.picoclaw
${hasProxy ? `    environment:
      PICOCLAW_PROXY_URL: http://${name}-api-proxy:8080` : ""}
${agentNetworks.length > 0 ? `    networks:\n${agentNetworks.map((n) => `      - ${n}`).join("\n")}` : ""}
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
          memory: 128M
          cpus: "0.5"
    healthcheck:
      test: ["CMD-SHELL", "nc -z localhost 18790 || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
${agentDeps.length > 0 ? `    depends_on:\n${agentDeps.join("\n")}` : ""}
    restart: unless-stopped

`;
    } else {
      services += `  ${name}-openclaw:
    image: ghcr.io/openclaw/openclaw:latest
    expose:
      - "18789"
    volumes:
      # Directory mount — OpenClaw needs atomic rename for config updates
      - ./${name}/openclaw:/home/node/.openclaw
    environment:
${hasProxy ? `      OPENCLAW_API_PROXY: http://${name}-api-proxy:8080` : `      # OPENCLAW_API_PROXY: not set (proxyMode: none)`}
      OPENCLAW_SANDBOX: 1
      OPENCLAW_AUDIT_LOG: /home/node/.openclaw/logs/audit.jsonl
${agentNetworks.length > 0 ? `    networks:\n${agentNetworks.map((n) => `      - ${n}`).join("\n")}` : ""}
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
${agentDeps.length > 0 ? `    depends_on:\n${agentDeps.join("\n")}` : ""}
    restart: unless-stopped

`;
    }

    if (processor === "mem0") {
      const backendNet = `${name}-backend`;
      const frontendNet = `${name}-frontend`;
      usedNetworks.add(backendNet);
      usedNetworks.add(frontendNet);

      services += `  ${name}-qdrant:
    image: qdrant/qdrant:v1.13.0
    expose:
      - "6333"
    volumes:
      - ./${name}/data/qdrant:/qdrant/storage
    networks:
      - ${backendNet}
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: "1.0"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:6333/healthz"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  ${name}-mem0:
    build: ./${name}/mem0
    expose:
      - "8050"
    environment:
      GEMINI_API_KEY: \${GEMINI_API_KEY}
      MEM0_API_KEY: \${MEM0_API_KEY}
      QDRANT_HOST: ${name}-qdrant
      QDRANT_PORT: 6333
    networks:
      - ${frontendNet}
      - ${backendNet}
    read_only: true
    tmpfs:
      - /tmp:size=100M
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "0.5"
    depends_on:
      ${name}-qdrant:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8050/health')"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

`;
    }
  }

  // Nginx reverse proxy: public-net (port binding) + per-project internal networks
  // proxy-net for projects with proxy, agent-net for proxyMode=none
  const nginxNetworks = [
    "public-net",
    ...nginxProjects.map((p) =>
      p.proxyMode !== "none" ? `${p.name}-proxy-net` : `${p.name}-agent-net`
    ),
  ];
  const portMappings = nginxProjects
    .map((p) => `      - "${p.port}:${p.port}"`)
    .join("\n");

  services += `  nginx:
    build: ./nginx
    ports:
${portMappings}
    networks:
${nginxNetworks.map((n) => `      - ${n}`).join("\n")}
    read_only: true
    tmpfs:
      - /tmp:size=10M
      - /var/cache/nginx:size=50M
      - /run:size=10M
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    deploy:
      resources:
        limits:
          memory: 128M
          cpus: "0.25"
    depends_on:
${nginxProjects.map((p) => `      ${p.containerName}:\n        condition: service_started`).join("\n")}
    restart: unless-stopped

`;

  // Networks
  let networks = "networks:\n";
  networks += "  public-net:\n    # nginx port binding to host\n";
  if (usedNetworks.has("egress-net")) {
    networks += "  egress-net:\n    # api-proxy outbound to Gemini API\n";
  }
  for (const p of nginxProjects) {
    const entry = reg.projects[p.name];
    const processor = (await readProjectConfig(entry.path))?.processor ?? entry.processor;
    if (p.proxyMode !== "none") {
      networks += `  ${p.name}-proxy-net:\n    internal: true\n`;
    } else {
      networks += `  ${p.name}-agent-net:\n    internal: true\n`;
    }
    if (processor === "mem0") {
      networks += `  ${p.name}-frontend:\n    internal: true\n`;
      networks += `  ${p.name}-backend:\n    internal: true\n`;
    }
  }

  const compose = `# Generated by claw-farm cloud:compose
# Production deployment with nginx reverse proxy + network isolation
#
# Architecture:
#   browser → nginx (public-net) → openclaw (proxy-net, internal)
#                                     → api-proxy (proxy-net + egress-net) → LLM API
#
# openclaw has NO internet access — fully isolated on internal network
# api-proxy is the only container with outbound internet (egress-net)
# nginx is the only container with host port binding (public-net)
services:
${services}${networks}`;

  await Bun.write(resolved, compose);

  // Write nginx config and Dockerfile
  const nginxDir = join(process.cwd(), "nginx");
  await mkdir(nginxDir, { recursive: true });
  await Bun.write(
    join(nginxDir, "nginx.conf"),
    nginxProxyTemplate(nginxProjects),
  );
  await Bun.write(join(nginxDir, "Dockerfile"), nginxDockerfileTemplate());

  console.log(`\n✅ Cloud compose written to: ${outFile}`);
  console.log(`   Includes ${names.length} project(s): ${names.join(", ")}`);
  console.log(`   Generated nginx/ (reverse proxy + Dockerfile)`);
  console.log(`\n   Network isolation:`);
  console.log(`     nginx      → public-net (host ports) + proxy-nets`);
  console.log(`     openclaw   → proxy-net only (internal, no internet)`);
  console.log(`     api-proxy  → proxy-net + egress-net (outbound only)`);
  console.log(``);
}
