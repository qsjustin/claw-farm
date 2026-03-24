#!/usr/bin/env bun

import { initCommand } from "./commands/init.ts";
import { upCommand } from "./commands/up.ts";
import { downCommand } from "./commands/down.ts";
import { listCommand } from "./commands/list.ts";
import { memoryRebuildCommand } from "./commands/memory-rebuild.ts";
import { cloudComposeCommand } from "./commands/cloud-compose.ts";
import { upgradeCommand } from "./commands/upgrade.ts";

const VERSION = "0.1.0";

const HELP = `
claw-farm v${VERSION} — Multi OpenClaw Instance Manager

Usage:
  claw-farm init <name>                  Scaffold OpenClaw project in current directory
  claw-farm init <name> --processor mem0 Scaffold with Mem0+Qdrant memory
  claw-farm init <name> --existing       Register existing setup without scaffolding
  claw-farm up [name|--all]              Start Docker Compose
  claw-farm down [name|--all]            Stop Docker Compose
  claw-farm list                         Show all projects with status
  claw-farm upgrade [name]               Re-generate claw-farm files with latest templates
  claw-farm memory:rebuild [name]        Rebuild processed memory from raw data
  claw-farm cloud:compose [outfile]      Generate unified cloud deploy compose

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
