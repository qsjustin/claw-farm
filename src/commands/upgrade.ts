import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveProjectName, type ProjectEntry } from "../lib/registry.ts";
import { readProjectConfig } from "../lib/config.ts";
import { ensureRawDirs } from "../lib/raw-collector.ts";
import { baseComposeTemplate } from "../templates/docker-compose.yml.ts";
import { mem0ComposeTemplate } from "../templates/docker-compose.mem0.yml.ts";
import { openclawConfigTemplate } from "../templates/openclaw.json5.ts";
import { policyTemplate } from "../templates/policy.yaml.ts";
import {
  apiProxyServerTemplate,
  apiProxyDockerfileTemplate,
  apiProxyRequirementsTemplate,
} from "../templates/api-proxy.ts";

export async function upgradeCommand(args: string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith("-"));
  const { name: projectName, entry } = await resolveProjectName(name);
  const projectDir = entry.path;
  const config = await readProjectConfig(projectDir);
  const processor = config?.processor ?? entry.processor;

  console.log(`\n🔄 Upgrading ${projectName} to latest claw-farm templates...`);
  console.log(`   Processor: ${processor}`);
  console.log(`   Port: ${entry.port}`);
  console.log(`   Path: ${projectDir}\n`);

  // Ensure directories
  await mkdir(join(projectDir, "openclaw", "config"), { recursive: true });
  await mkdir(join(projectDir, "openclaw", "processed"), { recursive: true });
  await mkdir(join(projectDir, "logs"), { recursive: true });
  await ensureRawDirs(projectDir);

  // --- Always regenerate these (claw-farm owned files) ---

  // 1. docker-compose.openclaw.yml
  const composeContent =
    processor === "mem0"
      ? mem0ComposeTemplate(projectName, entry.port)
      : baseComposeTemplate(projectName, entry.port);
  await Bun.write(join(projectDir, "docker-compose.openclaw.yml"), composeContent);
  console.log("✓ Updated docker-compose.openclaw.yml");

  // 2. openclaw.json5 (backup first)
  const configPath = join(projectDir, "openclaw", "config", "openclaw.json5");
  try {
    const existing = await Bun.file(configPath).text();
    await Bun.write(configPath + ".backup", existing);
  } catch {}
  await Bun.write(configPath, openclawConfigTemplate(projectName, processor));
  console.log("✓ Updated openclaw/config/openclaw.json5 (backup → .backup)");

  // 3. policy.yaml
  await Bun.write(
    join(projectDir, "openclaw", "config", "policy.yaml"),
    policyTemplate(projectName),
  );
  console.log("✓ Updated openclaw/config/policy.yaml");

  // 4. api-proxy (always overwrite — claw-farm owns this)
  const proxyDir = join(projectDir, "api-proxy");
  await mkdir(proxyDir, { recursive: true });
  await Bun.write(join(proxyDir, "api_proxy.py"), apiProxyServerTemplate());
  await Bun.write(join(proxyDir, "Dockerfile"), apiProxyDockerfileTemplate());
  await Bun.write(join(proxyDir, "requirements.txt"), apiProxyRequirementsTemplate());
  console.log("✓ Updated api-proxy/ (key isolation + PII filter + secret scan)");

  // 5. .env.example (overwrite — template only)
  const envContent = processor === "mem0"
    ? "GEMINI_API_KEY=\n# WARNING: Leave empty only for local development. Set a key for cloud deployments.\nMEM0_API_KEY=\n"
    : "GEMINI_API_KEY=\n";
  await Bun.write(join(projectDir, ".env.example"), envContent);
  console.log("✓ Updated .env.example");

  // --- Never touch these (user owned files) ---
  // - .env (has user's actual keys)
  // - openclaw/workspace/SOUL.md (user customized)
  // - openclaw/workspace/MEMORY.md (agent accumulated)
  // - openclaw/workspace/AGENTS.md (user customized)
  // - openclaw/workspace/skills/ (user created)
  // - openclaw/raw/ (immutable Layer 0)

  console.log(`\n✅ ${projectName} upgraded!`);
  console.log(`\n   Not touched: .env, SOUL.md, MEMORY.md, AGENTS.md, skills/, raw/`);
  console.log(`   Run: claw-farm up ${projectName}\n`);
}
