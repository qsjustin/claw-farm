import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { addProject, loadRegistry, saveRegistry } from "../lib/registry.ts";
import { writeProjectConfig } from "../lib/config.ts";
import { ensureRawDirs } from "../lib/raw-collector.ts";
import { baseComposeTemplate } from "../templates/docker-compose.yml.ts";
import { mem0ComposeTemplate } from "../templates/docker-compose.mem0.yml.ts";
import { openclawConfigTemplate } from "../templates/openclaw.json5.ts";
import { soulTemplate } from "../templates/SOUL.md.ts";
import { policyTemplate } from "../templates/policy.yaml.ts";
import {
  apiProxyServerTemplate,
  apiProxyDockerfileTemplate,
  apiProxyRequirementsTemplate,
} from "../templates/api-proxy.ts";
import { builtinProcessor } from "../processors/builtin.ts";
import { mem0Processor } from "../processors/mem0.ts";

export async function initCommand(args: string[]): Promise<void> {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Usage: claw-farm init <name> [--processor mem0] [--existing]");
    process.exit(1);
  }

  const processor = args.includes("--processor")
    ? (args[args.indexOf("--processor") + 1] as "builtin" | "mem0")
    : "builtin";

  const existing = args.includes("--existing");
  const projectDir = process.cwd();

  if (existing) {
    return registerExisting(name, projectDir, processor);
  }

  console.log(`\n🐾 Initializing claw-farm project: ${name}`);
  console.log(`   Processor: ${processor}`);
  console.log(`   Directory: ${projectDir}\n`);

  // Register in global registry
  const entry = await addProject(name, projectDir, processor);
  console.log(`✓ Registered in global registry (port: ${entry.port})`);

  // Create directory structure
  await mkdir(join(projectDir, "openclaw", "config"), { recursive: true });
  await mkdir(join(projectDir, "openclaw", "workspace", "skills"), { recursive: true });
  await mkdir(join(projectDir, "openclaw", "processed"), { recursive: true });
  await mkdir(join(projectDir, "logs"), { recursive: true });
  await ensureRawDirs(projectDir);
  console.log("✓ Created openclaw/ directory structure");

  // Write docker-compose
  const composeContent =
    processor === "mem0"
      ? mem0ComposeTemplate(name, entry.port)
      : baseComposeTemplate(name, entry.port);
  await Bun.write(join(projectDir, "docker-compose.openclaw.yml"), composeContent);
  console.log("✓ Generated docker-compose.openclaw.yml");

  // Write OpenClaw config
  await Bun.write(
    join(projectDir, "openclaw", "config", "openclaw.json5"),
    openclawConfigTemplate(name, processor),
  );
  console.log("✓ Generated openclaw/config/openclaw.json5");

  // Write policy.yaml (tool access restrictions)
  await Bun.write(
    join(projectDir, "openclaw", "config", "policy.yaml"),
    policyTemplate(name),
  );
  console.log("✓ Generated openclaw/config/policy.yaml");

  // Write API Proxy sidecar (key isolation + PII filter)
  const proxyDir = join(projectDir, "api-proxy");
  await mkdir(proxyDir, { recursive: true });
  await Bun.write(join(proxyDir, "api_proxy.py"), apiProxyServerTemplate());
  await Bun.write(join(proxyDir, "Dockerfile"), apiProxyDockerfileTemplate());
  await Bun.write(join(proxyDir, "requirements.txt"), apiProxyRequirementsTemplate());
  console.log("✓ Generated api-proxy/ (key isolation + PII filter)");

  // Write SOUL.md
  await Bun.write(
    join(projectDir, "openclaw", "workspace", "SOUL.md"),
    soulTemplate(name),
  );
  console.log("✓ Generated openclaw/workspace/SOUL.md");

  // Write initial MEMORY.md
  await Bun.write(
    join(projectDir, "openclaw", "workspace", "MEMORY.md"),
    `# ${name} — Memory\n\n> This file is updated automatically as the agent learns from conversations.\n`,
  );
  console.log("✓ Generated openclaw/workspace/MEMORY.md");

  // Write project config
  await writeProjectConfig(projectDir, {
    name,
    processor,
    port: entry.port,
    createdAt: entry.createdAt,
  });
  console.log("✓ Generated .claw-farm.json");

  // Init processor-specific files
  if (processor === "mem0") {
    await mem0Processor.init(projectDir);
    console.log("✓ Generated mem0/ sidecar files");

    // Write .env.example if not exists
    try {
      await Bun.file(join(projectDir, ".env.example")).text();
    } catch {
      await Bun.write(
        join(projectDir, ".env.example"),
        "GEMINI_API_KEY=\nMEM0_API_KEY=\n",
      );
    }
  } else {
    await builtinProcessor.init(projectDir);

    // Write .env.example
    try {
      await Bun.file(join(projectDir, ".env.example")).text();
    } catch {
      await Bun.write(join(projectDir, ".env.example"), "GEMINI_API_KEY=\n");
    }
  }

  console.log(`\n✅ Project "${name}" initialized!`);
  console.log(`\nNext steps:`);
  console.log(`  1. Copy .env.example to .env and fill in your API keys`);
  console.log(`  2. Run: claw-farm up ${name}`);
  console.log(`  3. Open: http://localhost:${entry.port}\n`);
}

async function registerExisting(
  name: string,
  projectDir: string,
  processor: "builtin" | "mem0",
): Promise<void> {
  console.log(`\n🐾 Registering existing project: ${name}`);

  const entry = await addProject(name, projectDir, processor);

  // Ensure directories exist
  await mkdir(join(projectDir, "openclaw", "config"), { recursive: true });
  await mkdir(join(projectDir, "openclaw", "processed"), { recursive: true });
  await mkdir(join(projectDir, "logs"), { recursive: true });
  await ensureRawDirs(projectDir);
  console.log("✓ Created raw/ + processed/ + logs/ directories");

  // Generate docker-compose.openclaw.yml (always — this is what claw-farm up uses)
  const composePath = join(projectDir, "docker-compose.openclaw.yml");
  const composeContent =
    processor === "mem0"
      ? mem0ComposeTemplate(name, entry.port)
      : baseComposeTemplate(name, entry.port);
  await Bun.write(composePath, composeContent);
  console.log("✓ Generated docker-compose.openclaw.yml");

  // Backup and update openclaw.json5 to use api-proxy
  const configPath = join(projectDir, "openclaw", "config", "openclaw.json5");
  try {
    const existing = await Bun.file(configPath).text();
    // Backup existing config
    const backupPath = configPath + ".backup";
    await Bun.write(backupPath, existing);
    console.log(`✓ Backed up existing openclaw.json5 → openclaw.json5.backup`);
  } catch {
    // No existing config — that's fine
  }
  await Bun.write(configPath, openclawConfigTemplate(name, processor));
  console.log("✓ Generated openclaw/config/openclaw.json5 (routes through api-proxy)");

  // Add policy.yaml if missing
  const policyPath = join(projectDir, "openclaw", "config", "policy.yaml");
  try {
    await Bun.file(policyPath).text();
    console.log("✓ policy.yaml already exists — skipped");
  } catch {
    await Bun.write(policyPath, policyTemplate(name));
    console.log("✓ Generated openclaw/config/policy.yaml");
  }

  // Add api-proxy if missing
  const proxyDir = join(projectDir, "api-proxy");
  try {
    await Bun.file(join(proxyDir, "api_proxy.py")).text();
    console.log("✓ api-proxy/ already exists — skipped");
  } catch {
    await mkdir(proxyDir, { recursive: true });
    await Bun.write(join(proxyDir, "api_proxy.py"), apiProxyServerTemplate());
    await Bun.write(join(proxyDir, "Dockerfile"), apiProxyDockerfileTemplate());
    await Bun.write(join(proxyDir, "requirements.txt"), apiProxyRequirementsTemplate());
    console.log("✓ Generated api-proxy/ (key isolation + PII filter)");
  }

  // Ensure .env.example exists
  const envExamplePath = join(projectDir, ".env.example");
  try {
    await Bun.file(envExamplePath).text();
    console.log("✓ .env.example already exists — skipped");
  } catch {
    const envContent = processor === "mem0"
      ? "GEMINI_API_KEY=\nMEM0_API_KEY=\n"
      : "GEMINI_API_KEY=\n";
    await Bun.write(envExamplePath, envContent);
    console.log("✓ Generated .env.example");
  }

  // Ensure .env exists (copy from .env.example if missing)
  const envPath = join(projectDir, ".env");
  try {
    await Bun.file(envPath).text();
    console.log("✓ .env already exists — skipped");
  } catch {
    try {
      const example = await Bun.file(envExamplePath).text();
      await Bun.write(envPath, example);
      console.log("✓ Created .env from .env.example (fill in your API keys!)");
    } catch {
      // No .env.example either — skip
    }
  }

  // Write project config
  await writeProjectConfig(projectDir, {
    name,
    processor,
    port: entry.port,
    createdAt: entry.createdAt,
  });

  console.log(`✓ Registered in global registry (port: ${entry.port})`);

  console.log(`\n✅ Existing project "${name}" registered!`);
  console.log(`\nYour existing docker-compose.yml is untouched.`);
  console.log(`claw-farm uses docker-compose.openclaw.yml (newly generated).`);
  console.log(`\nNext steps:`);
  console.log(`  1. Check .env has your GEMINI_API_KEY`);
  console.log(`  2. Run: claw-farm up ${name}`);
  console.log(`  3. Open: http://localhost:${entry.port}\n`);
}
