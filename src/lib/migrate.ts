import { join } from "node:path";
import { mkdir, cp, readdir } from "node:fs/promises";
import { loadRegistry, saveRegistry, withLock } from "./registry.ts";
import { readProjectConfig, writeProjectConfig } from "./config.ts";
import { ensureTemplateDirs, templateDir } from "./instance.ts";
import { userTemplateContent } from "../templates/USER.template.md.ts";
import { fileExists, copyIfExists } from "./fs-utils.ts";

/**
 * Migrate a single-instance project to multi-instance mode.
 *
 * 1. Create template/ from existing workspace files (SOUL.md, AGENTS.md, skills/, config/)
 * 2. Create instances/default/ from existing user data (MEMORY.md, raw/, processed/)
 * 3. Set multiInstance: true in registry and config
 * 4. Update .gitignore
 */
export async function migrateToMulti(
  projectName: string,
  projectDir: string,
): Promise<void> {
  // Idempotency: check if already migrated
  const config = await readProjectConfig(projectDir);
  if (config?.multiInstance) return;

  const runtimeDirName = config?.runtime === "picoclaw" ? "picoclaw" : "openclaw";
  const wsDir = join(projectDir, runtimeDirName, "workspace");
  const tmplDir = templateDir(projectDir);

  // Step 1: Create template/ from existing shared files
  await ensureTemplateDirs(projectDir);

  await copyIfExists(join(wsDir, "SOUL.md"), join(tmplDir, "SOUL.md"));
  await copyIfExists(join(wsDir, "AGENTS.md"), join(tmplDir, "AGENTS.md"));

  // Ensure AGENTS.md exists in template (even if source didn't have one)
  if (!await fileExists(join(tmplDir, "AGENTS.md"))) {
    await Bun.write(join(tmplDir, "AGENTS.md"), `# ${projectName} — Agents\n\n> Shared behavior rules for all instances.\n`);
  }

  // Copy skills/ → template/skills/
  try {
    const skillsDir = join(wsDir, "skills");
    const files = await readdir(skillsDir);
    await mkdir(join(tmplDir, "skills"), { recursive: true });
    for (const file of files) {
      await cp(join(skillsDir, file), join(tmplDir, "skills", file), { recursive: true });
    }
  } catch {
    // No skills directory
  }

  // Copy config files → template/config/ (check both old and new layout)
  await mkdir(join(tmplDir, "config"), { recursive: true });
  // New layout: openclaw/openclaw.json
  await copyIfExists(join(projectDir, runtimeDirName, config?.runtime === "picoclaw" ? "config.json" : "openclaw.json"), join(tmplDir, "config", config?.runtime === "picoclaw" ? "config.json" : "openclaw.json"));
  await copyIfExists(join(projectDir, runtimeDirName, "policy.yaml"), join(tmplDir, "config", "policy.yaml"));
  // Old layout fallback: openclaw/config/
  if (!await fileExists(join(tmplDir, "config", "openclaw.json"))) {
    await copyIfExists(join(projectDir, "openclaw", "config", "openclaw.json"), join(tmplDir, "config", "openclaw.json"));
  }
  if (!await fileExists(join(tmplDir, "config", "policy.yaml"))) {
    await copyIfExists(join(projectDir, "openclaw", "config", "policy.yaml"), join(tmplDir, "config", "policy.yaml"));
  }

  // Create USER.template.md
  await Bun.write(
    join(tmplDir, "USER.template.md"),
    userTemplateContent(projectName),
  );

  // Step 2: Migrate existing user data to instances/default/
  const defaultInstDir = join(projectDir, "instances", "default");
  const commonDirs = [
    mkdir(join(defaultInstDir, "raw", "workspace-snapshots"), { recursive: true, mode: 0o755 }),
    mkdir(join(defaultInstDir, "processed"), { recursive: true, mode: 0o755 }),
  ];

  if (runtimeDirName === "picoclaw") {
    await Promise.all([
      mkdir(join(defaultInstDir, "picoclaw", "workspace", "memory"), { recursive: true, mode: 0o755 }),
      mkdir(join(defaultInstDir, "picoclaw", "workspace", "sessions"), { recursive: true, mode: 0o755 }),
      mkdir(join(defaultInstDir, "picoclaw", "workspace", "state"), { recursive: true, mode: 0o755 }),
      ...commonDirs,
    ]);
  } else {
    await Promise.all([
      mkdir(join(defaultInstDir, "openclaw", "workspace", "memory"), { recursive: true, mode: 0o755 }),
      mkdir(join(defaultInstDir, "openclaw", "sessions"), { recursive: true, mode: 0o755 }),
      mkdir(join(defaultInstDir, "openclaw", "logs"), { recursive: true, mode: 0o755 }),
      ...commonDirs,
    ]);
  }

  // Copy config files to instance
  const configFileName = runtimeDirName === "picoclaw" ? "config.json" : "openclaw.json";
  await copyIfExists(join(tmplDir, "config", configFileName), join(defaultInstDir, runtimeDirName, configFileName));
  if (runtimeDirName === "openclaw") {
    await copyIfExists(join(tmplDir, "config", "policy.yaml"), join(defaultInstDir, runtimeDirName, "policy.yaml"));
  }

  // Move MEMORY.md to default instance
  const memoryDest = runtimeDirName === "picoclaw"
    ? join(defaultInstDir, runtimeDirName, "workspace", "memory", "MEMORY.md")
    : join(defaultInstDir, runtimeDirName, "workspace", "MEMORY.md");
  await copyIfExists(join(wsDir, "MEMORY.md"), memoryDest);
  // picoclaw stores memory under workspace/memory/
  if (runtimeDirName === "picoclaw") {
    await copyIfExists(join(wsDir, "memory", "MEMORY.md"), memoryDest);
  }

  // Create a USER.md for the default instance
  if (!await fileExists(join(defaultInstDir, runtimeDirName, "workspace", "USER.md"))) {
    await Bun.write(
      join(defaultInstDir, runtimeDirName, "workspace", "USER.md"),
      `# ${projectName} — User Profile (default)\n\n- User ID: default\n- Migrated from single-instance mode\n`,
    );
  }

  // Copy raw session logs (check runtime-specific locations)
  const sessionsSrc = runtimeDirName === "picoclaw"
    ? [join(projectDir, runtimeDirName, "workspace", "sessions")]
    : [join(projectDir, "openclaw", "sessions"), join(projectDir, "openclaw", "raw", "sessions")];
  const sessionsDest = runtimeDirName === "picoclaw"
    ? join(defaultInstDir, runtimeDirName, "workspace", "sessions")
    : join(defaultInstDir, "openclaw", "sessions");
  for (const sessionsDir of sessionsSrc) {
    try {
      const files = await readdir(sessionsDir);
      for (const file of files) {
        await cp(join(sessionsDir, file), join(sessionsDest, file), { recursive: true });
      }
      break;
    } catch {
      // Try next location
    }
  }

  // Copy workspace snapshots (check both old and new layout)
  for (const snapshotsDir of [
    join(projectDir, "raw", "workspace-snapshots"),
    join(projectDir, "openclaw", "raw", "workspace-snapshots"),
  ]) {
    try {
      const files = await readdir(snapshotsDir);
      for (const file of files) {
        await cp(
          join(snapshotsDir, file),
          join(defaultInstDir, "raw", "workspace-snapshots", file),
          { recursive: true },
        );
      }
      break;
    } catch {
      // Try next location
    }
  }

  // Copy processed/ (check both old and new layout)
  for (const processedDir of [
    join(projectDir, "processed"),
    join(projectDir, "openclaw", "processed"),
  ]) {
    try {
      const files = await readdir(processedDir);
      for (const file of files) {
        await cp(
          join(processedDir, file),
          join(defaultInstDir, "processed", file),
          { recursive: true },
        );
      }
      break;
    } catch {
      // Try next location
    }
  }

  // Step 3: Update .gitignore (single write, no double-write bug)
  const gitignorePath = join(projectDir, ".gitignore");
  let gitignoreContent = "";
  try {
    gitignoreContent = await Bun.file(gitignorePath).text();
  } catch {
    // No .gitignore yet
  }

  let modified = false;
  if (!gitignoreContent.includes("instances/")) {
    gitignoreContent += "\n# Per-user instance data (claw-farm multi-instance)\ninstances/\n";
    modified = true;
  }
  if (!gitignoreContent.includes("*.env")) {
    gitignoreContent += "*.env\n";
    modified = true;
  }
  if (modified) {
    await Bun.write(gitignorePath, gitignoreContent);
  }

  // Step 4: Set multiInstance in registry and config
  await withLock(async () => {
    const reg = await loadRegistry();
    const project = reg.projects[projectName];
    if (project) {
      project.multiInstance = true;
      if (!project.instances) project.instances = {};
      await saveRegistry(reg);
    }
  });

  if (config) {
    config.multiInstance = true;
    await writeProjectConfig(projectDir, config);
  }
}

