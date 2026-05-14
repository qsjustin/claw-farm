import { SAFE_NAME_REGEX, findPositionalArg } from "../lib/registry.ts";
import { despawn } from "../lib/api.ts";

export async function despawnCommand(args: string[]): Promise<void> {
  const projectArg = findPositionalArg(args);
  if (!projectArg) {
    console.error("Usage: claw-farm despawn <project> --user <id> [--keep-data] [--delete-data]");
    process.exit(1);
  }

  const userIdx = args.indexOf("--user");
  if (userIdx === -1 || !args[userIdx + 1]) {
    console.error("Missing --user <id>");
    process.exit(1);
  }
  const userId = args[userIdx + 1];
  const keepData = args.includes("--keep-data");
  const deleteData = args.includes("--delete-data");
  if (keepData && deleteData) {
    console.error("Use only one of --keep-data or --delete-data.");
    process.exit(1);
  }

  // Validate userId early for better CLI error messages
  if (!SAFE_NAME_REGEX.test(userId)) {
    console.error(`Invalid user ID: "${userId}". Use lowercase letters, numbers, hyphens, and underscores.`);
    process.exit(1);
  }

  console.log(`\n■ Despawning instance "${userId}" from ${projectArg}...`);

  await despawn(projectArg, userId, { keepData, deleteData });

  if (keepData) {
    console.log(`✓ Instance data preserved at: instances/${userId}/`);
  } else if (deleteData) {
    console.log(`✓ Instance data deleted by explicit request.`);
  }
  console.log(`\n✅ Instance "${userId}" despawned from ${projectArg}.`);
}
