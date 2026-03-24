import { resolve, relative, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadRegistry } from "../lib/registry.ts";
import { readProjectConfig } from "../lib/config.ts";
import { portRange } from "../lib/ports.ts";
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
    args.find((a) => !a.startsWith("-")) ?? "docker-compose.cloud.yml";

  // Output path validation — must stay within cwd
  const resolved = resolve(process.cwd(), outFile);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..")) {
    console.error("Output file must be within current directory");
    process.exit(1);
  }

  let services = "";
  const usedNetworks = new Set<string>();
  const usedVolumes = new Set<string>();
  const nginxProjects: Array<{
    name: string;
    port: number;
    containerName: string;
  }> = [];

  // Shared networks for cloud isolation
  usedNetworks.add("public-net"); // nginx ↔ host (port binding)
  usedNetworks.add("egress-net"); // api-proxy ↔ internet (Gemini API)

  for (const name of names) {
    const entry = reg.projects[name];
    const config = await readProjectConfig(entry.path);
    const processor = config?.processor ?? entry.processor;
    const ports = portRange(entry.port);
    const proxyNet = `${name}-proxy-net`;
    usedNetworks.add(proxyNet);
    const openclawLogsVol = `${name}-openclaw-logs`;
    usedVolumes.add(openclawLogsVol);

    nginxProjects.push({
      name,
      port: ports.openclaw,
      containerName: `${name}-openclaw`,
    });

    // API Proxy: proxy-net (internal, ↔ openclaw) + egress-net (outbound to Gemini)
    services += `  ${name}-api-proxy:
    build: ./${name}/api-proxy
    expose:
      - "8080"
    environment:
      GEMINI_API_KEY: \${GEMINI_API_KEY}
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

    // OpenClaw: proxy-net (internal only) — NO internet, NO port binding
    // nginx proxies to it via proxy-net
    services += `  ${name}-openclaw:
    image: ghcr.io/openclaw/openclaw:latest
    expose:
      - "18789"
    volumes:
      - ./${name}/openclaw/config/openclaw.json:/home/node/.openclaw/openclaw.json:ro
      - ./${name}/openclaw/config/policy.yaml:/home/node/.openclaw/policy.yaml:ro
      - ./${name}/openclaw/workspace:/home/node/.openclaw/workspace
      - ./${name}/openclaw/raw/sessions:/home/node/.openclaw/sessions
      - ${openclawLogsVol}:/home/node/.openclaw/logs
    environment:
      OPENCLAW_API_PROXY: http://${name}-api-proxy:8080
      OPENCLAW_SANDBOX: 1
      OPENCLAW_AUDIT_LOG: /home/node/.openclaw/logs/audit.jsonl
    networks:
      - ${proxyNet}
    read_only: true
    tmpfs:
      - /tmp:size=100M
      - /home/node/.cache:size=200M
      - /home/node/.openclaw:size=50M,uid=1000,gid=1000
      - /home/node/.openclaw/workspace:size=10M,uid=1000,gid=1000
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
    depends_on:
      ${name}-api-proxy:
        condition: service_healthy
    restart: unless-stopped

`;

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

  // Nginx reverse proxy: public-net (port binding) + all proxy-nets (internal comms)
  const nginxNetworks = [
    "public-net",
    ...names.map((n) => `${n}-proxy-net`),
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
  networks += "  egress-net:\n    # api-proxy outbound to Gemini API\n";
  for (const name of names) {
    networks += `  ${name}-proxy-net:\n    internal: true\n`;
    const config = await readProjectConfig(reg.projects[name].path);
    const processor = config?.processor ?? reg.projects[name].processor;
    if (processor === "mem0") {
      networks += `  ${name}-frontend:\n    internal: true\n`;
      networks += `  ${name}-backend:\n    internal: true\n`;
    }
  }

  // Volumes
  let volumes = "volumes:\n";
  for (const vol of usedVolumes) {
    volumes += `  ${vol}:\n`;
  }

  const compose = `# Generated by claw-farm cloud:compose
# Production deployment with nginx reverse proxy + network isolation
#
# Architecture:
#   browser → nginx (public-net) → openclaw (proxy-net, internal)
#                                     → api-proxy (proxy-net + egress-net) → Gemini API
#
# openclaw has NO internet access — fully isolated on internal network
# api-proxy is the only container with outbound internet (egress-net)
# nginx is the only container with host port binding (public-net)
services:
${services}${networks}
${volumes}`;

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
