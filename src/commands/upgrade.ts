import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveProjectName, type ProjectEntry } from "../lib/registry.ts";
import { readProjectConfig, mergeOpenclawConfig, envExampleTemplate } from "../lib/config.ts";
import { ensureRawDirs } from "../lib/raw-collector.ts";
import { ensureTemplateDirs, ensureInstanceDirs, templateDir, instanceDir } from "../lib/instance.ts";
import { baseComposeTemplate } from "../templates/docker-compose.yml.ts";
import { mem0ComposeTemplate } from "../templates/docker-compose.mem0.yml.ts";
import { instanceComposeTemplate } from "../templates/docker-compose.instance.yml.ts";
import { openclawConfigTemplate } from "../templates/openclaw.json.ts";
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
  const llm = config?.llm ?? "gemini";

  console.log(`\n🔄 Upgrading ${projectName} to latest claw-farm templates...`);
  console.log(`   Processor: ${processor}`);
  console.log(`   LLM provider: ${llm}`);
  console.log(`   Port: ${entry.port}`);
  console.log(`   Multi-instance: ${entry.multiInstance ? "yes" : "no"}`);
  console.log(`   Path: ${projectDir}\n`);

  if (entry.multiInstance) {
    return upgradeMultiInstance(projectName, entry, projectDir, processor, llm);
  }

  // --- Single-instance upgrade (unchanged) ---

  await mkdir(join(projectDir, "openclaw", "config"), { recursive: true });
  await mkdir(join(projectDir, "openclaw", "processed"), { recursive: true });
  await mkdir(join(projectDir, "logs"), { recursive: true });
  await ensureRawDirs(projectDir);

  const composeContent =
    processor === "mem0"
      ? mem0ComposeTemplate(projectName, entry.port)
      : baseComposeTemplate(projectName, entry.port);
  await Bun.write(join(projectDir, "docker-compose.openclaw.yml"), composeContent);
  console.log("✓ Updated docker-compose.openclaw.yml");

  const configPath = join(projectDir, "openclaw", "config", "openclaw.json");
  const templateConfig = openclawConfigTemplate(projectName, processor);
  let existingConfig: string | null = null;
  try {
    existingConfig = await Bun.file(configPath).text();
    await Bun.write(configPath + ".backup", existingConfig);
  } catch {}
  if (existingConfig) {
    await Bun.write(configPath, mergeOpenclawConfig(templateConfig, existingConfig));
    console.log("✓ Merged openclaw/config/openclaw.json (user settings preserved, backup → .backup)");
  } else {
    await Bun.write(configPath, templateConfig);
    console.log("✓ Created openclaw/config/openclaw.json");
  }

  await Bun.write(
    join(projectDir, "openclaw", "config", "policy.yaml"),
    policyTemplate(projectName),
  );
  console.log("✓ Updated openclaw/config/policy.yaml");

  const proxyDir = join(projectDir, "api-proxy");
  await mkdir(proxyDir, { recursive: true });
  await Bun.write(join(proxyDir, "api_proxy.py"), apiProxyServerTemplate());
  await Bun.write(join(proxyDir, "Dockerfile"), apiProxyDockerfileTemplate());
  await Bun.write(join(proxyDir, "requirements.txt"), apiProxyRequirementsTemplate());
  console.log("✓ Updated api-proxy/ (key isolation + PII filter + secret scan)");

  await Bun.write(join(projectDir, ".env.example"), envExampleTemplate(llm, processor));
  console.log("✓ Updated .env.example");

  console.log(`\n✅ ${projectName} upgraded!`);
  console.log(`\n   Not touched: .env, SOUL.md, MEMORY.md, AGENTS.md, skills/, raw/`);
  console.log(`   💡 Custom compose settings? Put them in docker-compose.openclaw.override.yml`);
  console.log(`      (auto-merged on up/down, survives upgrade)`);
  console.log(`   Run: claw-farm up ${projectName}\n`);
}

async function upgradeMultiInstance(
  projectName: string,
  entry: ProjectEntry,
  projectDir: string,
  processor: "builtin" | "mem0",
  llm: "gemini" | "anthropic" | "openai-compat" = "gemini",
): Promise<void> {
  // Upgrade shared template files
  const tmplDir = templateDir(projectDir);
  await ensureTemplateDirs(projectDir);

  const configPath = join(tmplDir, "config", "openclaw.json");
  const templateConfig = openclawConfigTemplate(projectName, processor);
  let existingConfig: string | null = null;
  try {
    existingConfig = await Bun.file(configPath).text();
    await Bun.write(configPath + ".backup", existingConfig);
  } catch {}
  if (existingConfig) {
    await Bun.write(configPath, mergeOpenclawConfig(templateConfig, existingConfig));
    console.log("✓ Merged template/config/openclaw.json (user settings preserved, backup → .backup)");
  } else {
    await Bun.write(configPath, templateConfig);
    console.log("✓ Created template/config/openclaw.json");
  }

  await Bun.write(
    join(tmplDir, "config", "policy.yaml"),
    policyTemplate(projectName),
  );
  console.log("✓ Updated template/config/policy.yaml");

  const proxyDir = join(projectDir, "api-proxy");
  await mkdir(proxyDir, { recursive: true });
  await Bun.write(join(proxyDir, "api_proxy.py"), apiProxyServerTemplate());
  await Bun.write(join(proxyDir, "Dockerfile"), apiProxyDockerfileTemplate());
  await Bun.write(join(proxyDir, "requirements.txt"), apiProxyRequirementsTemplate());
  console.log("✓ Updated api-proxy/ (key isolation + PII filter + secret scan)");

  await Bun.write(join(projectDir, ".env.example"), envExampleTemplate(llm, processor));
  console.log("✓ Updated .env.example");

  // Regenerate per-instance compose files + ensure directories
  const instances = entry.instances ?? {};
  const instanceIds = Object.keys(instances);
  if (instanceIds.length > 0) {
    for (const userId of instanceIds) {
      const inst = instances[userId];
      const instDir = instanceDir(projectDir, userId);
      // Ensure all required directories exist (memory/, logs/, raw/, etc.)
      await ensureInstanceDirs(projectDir, userId);
      const composeContent = instanceComposeTemplate(projectName, userId, inst.port);
      await Bun.write(join(instDir, "docker-compose.openclaw.yml"), composeContent);
    }
    console.log(`✓ Updated ${instanceIds.length} instance(s) (compose + directories)`);
  }

  console.log(`\n✅ ${projectName} upgraded!`);
  console.log(`\n   Not touched: .env, SOUL.md, AGENTS.md, skills/, USER.md, MEMORY.md, raw/`);
  console.log(`   💡 Custom compose settings? Put them in docker-compose.openclaw.override.yml`);
  console.log(`      (auto-merged on up/down, survives upgrade)`);
  console.log(`   Run: claw-farm up ${projectName}\n`);
}
