#!/usr/bin/env bun

import { initCommand } from "./commands/init.ts";
import { upCommand } from "./commands/up.ts";
import { downCommand } from "./commands/down.ts";
import { listCommand } from "./commands/list.ts";
import { memoryRebuildCommand } from "./commands/memory-rebuild.ts";
import { cloudComposeCommand } from "./commands/cloud-compose.ts";
import { upgradeCommand } from "./commands/upgrade.ts";
import { spawnCommand } from "./commands/spawn.ts";
import { despawnCommand } from "./commands/despawn.ts";
import { instancesCommand } from "./commands/instances.ts";

const VERSION = "0.2.0";

const HELP = `
claw-farm v${VERSION} — Multi OpenClaw Instance Manager

Usage:
  claw-farm init <name>                  Scaffold OpenClaw project in current directory
  claw-farm init <name> --multi          Scaffold multi-instance project (template/ structure)
  claw-farm init <name> --processor mem0 Scaffold with Mem0+Qdrant memory
  claw-farm init <name> --llm <provider> Set LLM provider (gemini|anthropic|openai-compat)
  claw-farm init <name> --existing       Register existing setup without scaffolding
  claw-farm up [name|--all]              Start Docker Compose
  claw-farm up <name> --user <id>        Start specific instance
  claw-farm down [name|--all]            Stop Docker Compose
  claw-farm down <name> --user <id>      Stop specific instance
  claw-farm list                         Show all projects with status
  claw-farm spawn <project> --user <id>  Create and start a new instance from template
  claw-farm despawn <project> --user <id> Stop and remove an instance
  claw-farm instances <project>          List all instances for a project
  claw-farm upgrade [name]               Re-generate claw-farm files with latest templates
  claw-farm memory:rebuild [name]        Rebuild processed memory from raw data
  claw-farm cloud:compose [outfile]      Generate unified cloud deploy compose

Spawn options:
  --context k=v k2=v2   Fill USER.template.md placeholders (space-separated)
  --no-start             Create instance without starting containers

Despawn options:
  --keep-data            Keep instance data after stopping

Options:
  -h, --help     Show this help
  -v, --version  Show version
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  if (!command || command === "-h" || command === "--help") {
    console.log(HELP);
    return;
  }

  if (command === "-v" || command === "--version") {
    console.log(`claw-farm v${VERSION}`);
    return;
  }

  try {
    switch (command) {
      case "init":
        await initCommand(commandArgs);
        break;
      case "up":
        await upCommand(commandArgs);
        break;
      case "down":
        await downCommand(commandArgs);
        break;
      case "list":
      case "ls":
        await listCommand();
        break;
      case "spawn":
        await spawnCommand(commandArgs);
        break;
      case "despawn":
        await despawnCommand(commandArgs);
        break;
      case "instances":
        await instancesCommand(commandArgs);
        break;
      case "upgrade":
        await upgradeCommand(commandArgs);
        break;
      case "memory:rebuild":
        await memoryRebuildCommand(commandArgs);
        break;
      case "cloud:compose":
        await cloudComposeCommand(commandArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main();
