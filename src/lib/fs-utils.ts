import { access, readdir } from "node:fs/promises";

/** Returns true if a file exists at the given path. */
export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/**
 * Copy a file from src to dest only if it exists.
 * No-ops silently if src does not exist.
 */
export async function copyIfExists(src: string, dest: string): Promise<void> {
  const file = Bun.file(src);
  if (!await file.exists()) return;
  await Bun.write(dest, await file.arrayBuffer());
}

/** Returns true if a directory exists at the given path. */
export async function dirExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}
