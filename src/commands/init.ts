import { join } from "node:path";
import { mkdir, chmod } from "node:fs/promises";
import { addProject, loadRegistry, saveRegistry, withLock, findPositionalArg } from "../lib/registry.ts";
import { writeProjectConfig, envExampleTemplate, type LlmProvider } from "../lib/config.ts";
import { ensureRawDirs } from "../lib/raw-collector.ts";
import { mem0ComposeTemplate } from "../templates/docker-compose.mem0.yml.ts";
import { COMPOSE_FILENAME } from "../lib/compose.ts";
import { soulTemplate } from "../templates/SOUL.md.ts";
import { policyTemplate } from "../templates/policy.yaml.ts";
import { writeApiProxyFiles } from "../templates/api-proxy.ts";
import { builtinProcessor } from "../processors/builtin.ts";
import { mem0Processor } from "../processors/mem0.ts";
import { ensureTemplateDirs, templateDir } from "../lib/instance.ts";
import { userTemplateContent } from "../templates/USER.template.md.ts";
import { getRuntime, type RuntimeType, type ProxyMode } from "../runtimes/index.ts";

export async function initCommand(args: string[]): Promise<void> {
  const name = findPositionalArg(args);
  if (!name) {
    console.error("Usage: claw-farm init <name> [--runtime openclaw|picoclaw] [--processor mem0] [--existing] [--multi]");
    process.exit(1);
  }

  const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,62}$/;
  if (!NAME_REGEX.test(name)) {
    console.error(`Invalid project name: "${name}". Use lowercase letters, numbers, and hyphens only (e.g., "my-agent").`);
    process.exit(1);
  }

  const VALID_PROCESSORS = ["builtin", "mem0"] as const;
  const processorIdx = args.indexOf("--processor");
  const processorArg = processorIdx !== -1 ? args[processorIdx + 1] : undefined;
  if (processorIdx !== -1 && (!processorArg || processorArg.startsWith("-"))) {
    console.error(`Missing value for --processor. Must be one of: ${VALID_PROCESSORS.join(", ")}`);
    process.exit(1);
  }
  const processor: "builtin" | "mem0" = (processorArg as "builtin" | "mem0") ?? "builtin";
  if (processorIdx !== -1 && !VALID_PROCESSORS.includes(processor)) {
    console.error(`Invalid processor: "${processor}". Must be one of: ${VALID_PROCESSORS.join(", ")}`);
    process.exit(1);
  }

  const VALID_LLM_PROVIDERS = ["gemini", "anthropic", "openai-compat"] as const;
  const llmIdx = args.indexOf("--llm");
  const llmArg = llmIdx !== -1 ? args[llmIdx + 1] : undefined;
  if (llmIdx !== -1 && (!llmArg || llmArg.startsWith("-"))) {
    console.error(`Missing value for --llm. Must be one of: ${VALID_LLM_PROVIDERS.join(", ")}`);
    process.exit(1);
  }
  const llm: LlmProvider = (llmArg as LlmProvider) ?? "gemini";
  if (llmIdx !== -1 && !VALID_LLM_PROVIDERS.includes(llm)) {
    console.error(`Invalid LLM provider: "${llm}". Must be one of: ${VALID_LLM_PROVIDERS.join(", ")}`);
    process.exit(1);
  }

  // Parse --runtime flag
  const VALID_RUNTIMES = ["openclaw", "picoclaw"] as const;
  const runtimeIdx = args.indexOf("--runtime");
  const runtimeArg = runtimeIdx !== -1 ? args[runtimeIdx + 1] : undefined;
  if (runtimeIdx !== -1 && (!runtimeArg || runtimeArg.startsWith("-"))) {
    console.error(`Missing value for --runtime. Must be one of: ${VALID_RUNTIMES.join(", ")}`);
    process.exit(1);
  }
  const runtimeType: RuntimeType = (runtimeArg as RuntimeType) ?? "openclaw";
  if (runtimeIdx !== -1 && !(VALID_RUNTIMES as readonly string[]).includes(runtimeType)) {
    console.error(`Invalid runtime: "${runtimeType}". Must be one of: ${VALID_RUNTIMES.join(", ")}`);
    process.exit(1);
  }

  const runtime = getRuntime(runtimeType);

  // Parse --proxy-mode flag
  const VALID_PROXY_MODES = ["shared", "per-instance", "none"] as const;
  const proxyModeIdx = args.indexOf("--proxy-mode");
  const proxyModeArg = proxyModeIdx !== -1 ? args[proxyModeIdx + 1] : undefined;
  if (proxyModeIdx !== -1 && (!proxyModeArg || proxyModeArg.startsWith("-"))) {
    console.error(`Missing value for --proxy-mode. Must be one of: ${VALID_PROXY_MODES.join(", ")}`);
    process.exit(1);
  }
  const proxyMode = (proxyModeArg as ProxyMode) ?? runtime.defaultProxyMode;
  if (proxyModeIdx !== -1 && !(VALID_PROXY_MODES as readonly string[]).includes(proxyMode)) {
    console.error(`Invalid proxy mode: "${proxyMode}". Must be one of: ${VALID_PROXY_MODES.join(", ")}`);
    process.exit(1);
  }

  // Block unsupported combinations
  if (processor === "mem0" && runtimeType === "picoclaw") {
    console.error("Error: mem0 processor is not yet supported with picoclaw runtime.");
    console.error("Use --processor builtin (default) with --runtime picoclaw.");
    process.exit(1);
  }

  const existing = args.includes("--existing");
  const multi = args.includes("--multi");
  const projectDir = process.cwd();

  if (existing) {
    return registerExisting(name, projectDir, processor, llm, runtimeType, proxyMode);
  }

  if (multi) {
    return initMulti(name, projectDir, processor, llm, runtimeType, proxyMode);
  }

  console.log(`\n🐾 Initializing claw-farm project: ${name}`);
  console.log(`   Runtime: ${runtimeType}`);
  console.log(`   Processor: ${processor}`);
  console.log(`   LLM provider: ${llm}`);
  console.log(`   Directory: ${projectDir}\n`);

  // Register in global registry
  const entry = await addProject(name, projectDir, processor, runtimeType);
  console.log(`✓ Registered in global registry (port: ${entry.port})`);

  // Create directory structure
  const rtDir = runtime.runtimeDirName;
  await mkdir(join(projectDir, rtDir, "workspace", "skills"), { recursive: true });
  if (runtimeType === "picoclaw") {
    // picoclaw stores sessions and state under workspace/
    await mkdir(join(projectDir, rtDir, "workspace", "sessions"), { recursive: true });
    await mkdir(join(projectDir, rtDir, "workspace", "state"), { recursive: true });
  }
  await mkdir(join(projectDir, "processed"), { recursive: true });
  await mkdir(join(projectDir, "logs"), { recursive: true });
  await ensureRawDirs(projectDir, runtimeType);
  console.log(`✓ Created ${rtDir}/ directory structure`);

  // Write docker-compose
  const composeContent =
    processor === "mem0"
      ? mem0ComposeTemplate(name, entry.port)
      : runtime.composeTemplate(name, entry.port, proxyMode);
  await Bun.write(join(projectDir, COMPOSE_FILENAME), composeContent);
  console.log("✓ Generated docker-compose.openclaw.yml");

  // Write runtime config
  await Bun.write(
    join(projectDir, rtDir, runtime.configFileName),
    runtime.configTemplate(name, processor, llm),
  );
  console.log(`✓ Generated ${rtDir}/${runtime.configFileName}`);

  // Write additional config files (e.g., policy.yaml for openclaw)
  for (const configFile of runtime.additionalConfigFiles) {
    if (configFile === "policy.yaml") {
      await Bun.write(
        join(projectDir, rtDir, configFile),
        policyTemplate(name),
      );
      console.log(`✓ Generated ${rtDir}/${configFile}`);
    }
  }

  // Write API Proxy sidecar (key isolation + PII filter) — skip if proxyMode=none
  if (proxyMode !== "none") {
    await writeApiProxyFiles(projectDir);
    console.log("✓ Generated api-proxy/ (key isolation + PII filter)");
  } else {
    console.log("✓ Skipped api-proxy/ (proxyMode: none)");
  }

  // Write SOUL.md
  await Bun.write(
    join(projectDir, rtDir, "workspace", "SOUL.md"),
    soulTemplate(name),
  );
  console.log(`✓ Generated ${rtDir}/workspace/SOUL.md`);

  // Write initial MEMORY.md (picoclaw uses workspace/memory/MEMORY.md)
  const memoryDir = runtimeType === "picoclaw"
    ? join(projectDir, rtDir, "workspace", "memory")
    : join(projectDir, rtDir, "workspace");
  await mkdir(memoryDir, { recursive: true });
  await Bun.write(
    join(memoryDir, "MEMORY.md"),
    `# ${name} — Memory\n\n> This file is updated automatically as the agent learns from conversations.\n`,
  );
  console.log(`✓ Generated MEMORY.md`);

  // Write project config
  await writeProjectConfig(projectDir, {
    name,
    processor,
    port: entry.port,
    createdAt: entry.createdAt,
    llm,
    runtime: runtimeType,
    ...(proxyMode !== runtime.defaultProxyMode ? { proxyMode } : {}),
  });
  console.log("✓ Generated .claw-farm.json");

  // Init processor-specific files
  if (processor === "mem0") {
    await mem0Processor.init(projectDir);
    console.log("✓ Generated mem0/ sidecar files");
  } else {
    await builtinProcessor.init(projectDir);
  }

  // Write .env.example if not exists
  if (!await Bun.file(join(projectDir, ".env.example")).exists()) {
    await Bun.write(join(projectDir, ".env.example"), envExampleTemplate(llm, processor));
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
  llm: LlmProvider = "gemini",
  runtimeType: RuntimeType = "openclaw",
  proxyMode: ProxyMode = "per-instance",
): Promise<void> {
  const runtime = getRuntime(runtimeType);
  const rtDir = runtime.runtimeDirName;

  console.log(`\n🐾 Registering existing project: ${name}`);

  const entry = await addProject(name, projectDir, processor, runtimeType);

  // Ensure directories exist
  await mkdir(join(projectDir, rtDir, "workspace"), { recursive: true });
  await mkdir(join(projectDir, "processed"), { recursive: true });
  await mkdir(join(projectDir, "logs"), { recursive: true });
  await ensureRawDirs(projectDir, runtimeType);
  console.log("✓ Created directories");

  // Generate docker-compose.openclaw.yml (always — this is what claw-farm up uses)
  const composePath = join(projectDir, COMPOSE_FILENAME);
  const composeContent =
    processor === "mem0"
      ? mem0ComposeTemplate(name, entry.port)
      : runtime.composeTemplate(name, entry.port, proxyMode);
  await Bun.write(composePath, composeContent);
  console.log("✓ Generated docker-compose.openclaw.yml");

  // Backup and update config to use api-proxy
  const configPath = join(projectDir, rtDir, runtime.configFileName);
  try {
    const existingContent = await Bun.file(configPath).text();
    const backupPath = configPath + ".backup";
    await Bun.write(backupPath, existingContent);
    console.log(`✓ Backed up existing ${runtime.configFileName} → ${runtime.configFileName}.backup`);
  } catch {
    // No existing config — that's fine
  }
  await Bun.write(configPath, runtime.configTemplate(name, processor, llm));
  console.log(`✓ Generated ${rtDir}/${runtime.configFileName} (routes through api-proxy)`);

  // Add additional config files if missing
  for (const configFile of runtime.additionalConfigFiles) {
    const cfgPath = join(projectDir, rtDir, configFile);
    try {
      await Bun.file(cfgPath).text();
      console.log(`✓ ${configFile} already exists — skipped`);
    } catch {
      if (configFile === "policy.yaml") {
        await Bun.write(cfgPath, policyTemplate(name));
      }
      console.log(`✓ Generated ${rtDir}/${configFile}`);
    }
  }

  // Add api-proxy if missing — skip if proxyMode=none
  if (proxyMode !== "none") {
    if (await Bun.file(join(projectDir, "api-proxy", "api_proxy.py")).exists()) {
      console.log("✓ api-proxy/ already exists — skipped");
    } else {
      await writeApiProxyFiles(projectDir);
      console.log("✓ Generated api-proxy/ (key isolation + PII filter)");
    }
  } else {
    console.log("✓ Skipped api-proxy/ (proxyMode: none)");
  }

  // Ensure .env.example exists
  const envExamplePath = join(projectDir, ".env.example");
  try {
    await Bun.file(envExamplePath).text();
    console.log("✓ .env.example already exists — skipped");
  } catch {
    await Bun.write(envExamplePath, envExampleTemplate(llm, processor));
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
      await chmod(envPath, 0o600);
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
    llm,
    runtime: runtimeType,
    ...(proxyMode !== runtime.defaultProxyMode ? { proxyMode } : {}),
  });

  console.log(`✓ Registered in global registry (port: ${entry.port})`);

  console.log(`\n✅ Existing project "${name}" registered!`);
  console.log(`\nYour existing docker-compose.yml is untouched.`);
  console.log(`claw-farm uses docker-compose.openclaw.yml (newly generated).`);
  console.log(`\nNext steps:`);
  console.log(`  1. Check .env has your API keys (provider: ${llm})`);
  console.log(`  2. Run: claw-farm up ${name}`);
  console.log(`  3. Open: http://localhost:${entry.port}\n`);
}

async function initMulti(
  name: string,
  projectDir: string,
  processor: "builtin" | "mem0",
  llm: LlmProvider = "gemini",
  runtimeType: RuntimeType = "openclaw",
  proxyMode: ProxyMode = "per-instance",
): Promise<void> {
  const runtime = getRuntime(runtimeType);

  console.log(`\n🐾 Initializing multi-instance project: ${name}`);
  console.log(`   Runtime: ${runtimeType}`);
  console.log(`   Processor: ${processor}`);
  console.log(`   LLM provider: ${llm}`);
  console.log(`   Mode: multi-instance`);
  console.log(`   Directory: ${projectDir}\n`);

  // Register in global registry (with multiInstance flag)
  const entry = await addProject(name, projectDir, processor, runtimeType);

  // Set multiInstance in registry
  await withLock(async () => {
    const reg = await loadRegistry();
    reg.projects[name].multiInstance = true;
    reg.projects[name].instances = {};
    reg.projects[name].runtime = runtimeType;
    await saveRegistry(reg);
  });
  console.log(`✓ Registered in global registry (port: ${entry.port}, multi-instance)`);

  // Create template/ directory structure
  const tmplDir = templateDir(projectDir);
  await ensureTemplateDirs(projectDir);
  await mkdir(join(projectDir, "logs"), { recursive: true });
  console.log("✓ Created template/ directory structure");

  // Write template files
  await Bun.write(join(tmplDir, "SOUL.md"), soulTemplate(name));
  console.log("✓ Generated template/SOUL.md");

  await Bun.write(join(tmplDir, "AGENTS.md"), `# ${name} — Agents\n\n> Shared behavior rules for all instances.\n`);
  console.log("✓ Generated template/AGENTS.md");

  await Bun.write(join(tmplDir, "USER.template.md"), userTemplateContent(name));
  console.log("✓ Generated template/USER.template.md");

  // Write config files
  await Bun.write(
    join(tmplDir, "config", runtime.configFileName),
    runtime.configTemplate(name, processor, llm),
  );
  console.log(`✓ Generated template/config/${runtime.configFileName}`);

  // Write additional config files
  for (const configFile of runtime.additionalConfigFiles) {
    if (configFile === "policy.yaml") {
      await Bun.write(
        join(tmplDir, "config", configFile),
        policyTemplate(name),
      );
      console.log(`✓ Generated template/config/${configFile}`);
    }
  }

  // Write API Proxy sidecar — skip if proxyMode=none
  if (proxyMode !== "none") {
    await writeApiProxyFiles(projectDir);
    console.log("✓ Generated api-proxy/ (key isolation + PII filter)");
  } else {
    console.log("✓ Skipped api-proxy/ (proxyMode: none)");
  }

  // Write .env.example
  await Bun.write(join(projectDir, ".env.example"), envExampleTemplate(llm, processor));
  console.log("✓ Generated .env.example");

  // Write .gitignore
  await Bun.write(
    join(projectDir, ".gitignore"),
    `# Per-user instance data (claw-farm multi-instance)\ninstances/\n*.env\n`,
  );
  console.log("✓ Generated .gitignore");

  // Write shared proxy compose if proxyMode=shared
  if (proxyMode === "shared" && runtime.proxyComposeTemplate) {
    const proxyComposePath = join(projectDir, "docker-compose.proxy.yml");
    await Bun.write(proxyComposePath, runtime.proxyComposeTemplate(name));
    console.log("✓ Generated docker-compose.proxy.yml (shared api-proxy)");
  }

  // Write project config
  await writeProjectConfig(projectDir, {
    name,
    processor,
    port: entry.port,
    createdAt: entry.createdAt,
    multiInstance: true,
    llm,
    runtime: runtimeType,
    ...(proxyMode !== runtime.defaultProxyMode ? { proxyMode } : {}),
  });
  console.log("✓ Generated .claw-farm.json");

  // Init processor-specific files
  if (processor === "mem0") {
    await mem0Processor.init(projectDir);
    console.log("✓ Generated mem0/ sidecar files");
  }

  console.log(`\n✅ Multi-instance project "${name}" initialized!`);
  console.log(`\nNext steps:`);
  console.log(`  1. Copy .env.example to .env and fill in your API keys`);
  console.log(`  2. Customize template/SOUL.md and template/USER.template.md`);
  console.log(`  3. Spawn an instance: claw-farm spawn ${name} --user <user-id>`);
  console.log(`  4. Open: http://localhost:<assigned-port>\n`);
}
