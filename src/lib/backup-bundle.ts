import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { getRuntime } from "../runtimes/index.ts";
import type { RuntimeType } from "../runtimes/interface.ts";
import { dirExists, fileExists } from "./fs-utils.ts";
import { resolveWorkspaceLayout, type WorkspaceLayout } from "./workspace-layout.ts";

export const DEFAULT_INCLUDED_PATHS = ["config", "skills", "sessions"] as const;
export const DEFAULT_EXCLUDED_PATHS = ["cache", "tmp"] as const;
export const BUNDLE_FORMAT = "tar.zst";
const MANIFEST_VERSION = "1";

export interface BackupBundleManifest {
  manifestVersion: "1";
  backupId: string;
  instanceId: string;
  userId: string;
  runtimeType: "openclaw";
  workspaceSlug: string;
  createdAt: string;
  fileCount: number;
  sizeBytes: number;
  checksum: string;
  includedPaths: string[];
  excludedPaths: string[];
}

export interface ExportBundleOptions {
  projectDir: string;
  projectName: string;
  userId: string;
  runtimeType: RuntimeType;
  runtimeWorkspaceSlug: string;
  exportRoot: string;
  includedPaths?: string[];
  excludedPaths?: string[];
  bundleFormat?: string;
  instanceId?: string;
}

export interface ExportBundleResult {
  bundlePath: string;
  manifestPath: string;
  checksumPath: string;
  fileCount: number;
  sizeBytes: number;
  bundleChecksum: string;
  manifest: BackupBundleManifest;
}

export interface ImportBundleOptions {
  projectDir: string;
  userId: string;
  runtimeType: RuntimeType;
  runtimeWorkspaceSlug: string;
  bundlePath: string;
  manifestPath: string;
}

export interface ImportBundleResult {
  restoredFileCount: number;
  bundleChecksum: string;
  rebuildRequired: boolean;
  manifest: BackupBundleManifest;
}

function nowIso(): string {
  return new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function ensureBundleTooling(): void {
  const missing = ["tar", "zstd"].filter((tool) => !Bun.which(tool));
  if (missing.length > 0) {
    throw new Error(
      `Missing required backup tools: ${missing.join(", ")}. Install them before using instance.export/import.`,
    );
  }
}

export function normalizeIncludedPaths(includedPaths?: string[]): string[] {
  return unique([...(includedPaths ?? DEFAULT_INCLUDED_PATHS), "runtime"]);
}

export function normalizeExcludedPaths(excludedPaths?: string[]): string[] {
  return unique(excludedPaths ?? [...DEFAULT_EXCLUDED_PATHS]);
}

async function walkFiles(root: string): Promise<string[]> {
  if (!await dirExists(root)) return [];
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(entryPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(entryPath);
    }
  }

  return results.sort();
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  return hash.digest("hex");
}

async function runCommand(
  args: string[],
  options?: { cwd?: string },
): Promise<void> {
  const proc = Bun.spawn(args, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      detail
        ? `${args[0]} failed with exit code ${exitCode}: ${detail}`
        : `${args[0]} failed with exit code ${exitCode}`,
    );
  }
}

export function resolveRuntimeLayout(
  projectDir: string,
  userId: string,
  runtimeType: RuntimeType,
  runtimeWorkspaceSlug: string,
): WorkspaceLayout {
  const layout = resolveWorkspaceLayout(projectDir, userId, runtimeType);
  if (layout.runtimeWorkspaceSlug !== runtimeWorkspaceSlug) {
    throw new Error(
      `runtimeWorkspaceSlug mismatch: expected "${layout.runtimeWorkspaceSlug}", got "${runtimeWorkspaceSlug}"`,
    );
  }
  return layout;
}

function buildRuntimeDescriptor(input: {
  layout: WorkspaceLayout;
  runtimeType: RuntimeType;
  includedPaths: string[];
  excludedPaths: string[];
  createdAt: string;
}): Record<string, unknown> {
  return {
    runtimeType: input.runtimeType,
    workspaceSlug: input.layout.runtimeWorkspaceSlug,
    createdAt: input.createdAt,
    includedPaths: input.includedPaths,
    excludedPaths: input.excludedPaths,
    sidecarAttachPoints: [],
  };
}

async function enrichRuntimeDescriptor(
  layout: WorkspaceLayout,
  descriptorPath: string,
  runtimeType: RuntimeType,
  includedPaths: string[],
  excludedPaths: string[],
): Promise<void> {
  const descriptor = buildRuntimeDescriptor({
    layout,
    runtimeType,
    includedPaths,
    excludedPaths,
    createdAt: nowIso(),
  });
  const runtimeDir = join(layout.workspaceRoot, "runtime");
  if (await dirExists(runtimeDir)) {
    const entries = await readdir(runtimeDir, { withFileTypes: true });
    descriptor.sidecarAttachPoints = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("sidecar-"))
      .map((entry) => ({
        providerCode: entry.name.slice("sidecar-".length),
        path: `runtime/${entry.name}`,
      }));
  }

  await mkdir(dirname(descriptorPath), { recursive: true });
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
}

async function copyIncludedPaths(
  layout: WorkspaceLayout,
  stageRoot: string,
  includedPaths: string[],
): Promise<void> {
  for (const relPath of includedPaths) {
    const source = join(layout.workspaceRoot, relPath);
    if (!await fileExists(source) && !await dirExists(source)) {
      continue;
    }
    await mkdir(dirname(join(stageRoot, relPath)), { recursive: true });
    await cp(source, join(stageRoot, relPath), { recursive: true });
  }
}

async function createArchive(stageRoot: string, bundlePath: string): Promise<void> {
  ensureBundleTooling();
  await runCommand([
    "tar",
    "-C",
    stageRoot,
    "--use-compress-program",
    "zstd -q",
    "-cf",
    bundlePath,
    ".",
  ]);
}

async function extractArchive(bundlePath: string, extractRoot: string): Promise<void> {
  await mkdir(extractRoot, { recursive: true });
  ensureBundleTooling();
  await runCommand([
    "tar",
    "--use-compress-program",
    "zstd -d -q",
    "-xf",
    bundlePath,
    "-C",
    extractRoot,
  ]);
}

export async function exportInstanceBundle(options: ExportBundleOptions): Promise<ExportBundleResult> {
  if ((options.bundleFormat ?? BUNDLE_FORMAT) !== BUNDLE_FORMAT) {
    throw new Error(`Unsupported bundleFormat: "${options.bundleFormat}"`);
  }
  if (options.runtimeType !== "openclaw") {
    throw new Error(`Unsupported runtimeType for export: "${options.runtimeType}"`);
  }

  const layout = resolveRuntimeLayout(
    options.projectDir,
    options.userId,
    options.runtimeType,
    options.runtimeWorkspaceSlug,
  );
  const includedPaths = normalizeIncludedPaths(options.includedPaths);
  const excludedPaths = normalizeExcludedPaths(options.excludedPaths);
  const backupId = `bkp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const exportDir = join(options.exportRoot, backupId);
  const stageRoot = join(exportDir, "stage");

  await mkdir(stageRoot, { recursive: true });
  await copyIncludedPaths(layout, stageRoot, includedPaths);
  await enrichRuntimeDescriptor(
    layout,
    join(stageRoot, "runtime", "descriptor.json"),
    options.runtimeType,
    includedPaths,
    excludedPaths,
  );

  const bundlePath = join(exportDir, `instance.${BUNDLE_FORMAT}`);
  const manifestPath = join(exportDir, "manifest.json");
  const checksumPath = join(exportDir, "sha256.txt");

  await createArchive(stageRoot, bundlePath);

  const bundleChecksum = `sha256:${await hashFile(bundlePath)}`;
  const bundleStat = await stat(bundlePath);
  const fileCount = (await walkFiles(stageRoot)).length;
  const manifest: BackupBundleManifest = {
    manifestVersion: MANIFEST_VERSION,
    backupId,
    instanceId: options.instanceId ?? `${options.projectName}:${options.userId}`,
    userId: options.userId,
    runtimeType: "openclaw",
    workspaceSlug: layout.runtimeWorkspaceSlug,
    createdAt: nowIso(),
    fileCount,
    sizeBytes: bundleStat.size,
    checksum: bundleChecksum,
    includedPaths,
    excludedPaths,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(checksumPath, `${bundleChecksum.replace(/^sha256:/, "")}  instance.${BUNDLE_FORMAT}\n`, "utf8");
  await rm(stageRoot, { recursive: true, force: true });

  return {
    bundlePath,
    manifestPath,
    checksumPath,
    fileCount,
    sizeBytes: bundleStat.size,
    bundleChecksum,
    manifest,
  };
}

export async function readBackupManifest(path: string): Promise<BackupBundleManifest> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Partial<BackupBundleManifest>;
  if (raw.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`Unsupported manifestVersion: "${raw.manifestVersion ?? "missing"}"`);
  }
  if (raw.runtimeType !== "openclaw") {
    throw new Error(`Unsupported runtimeType: "${raw.runtimeType ?? "missing"}"`);
  }
  if (!raw.workspaceSlug || !raw.checksum) {
    throw new Error("Manifest missing required workspaceSlug/checksum fields");
  }
  return raw as BackupBundleManifest;
}

async function removePathIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function importInstanceBundle(options: ImportBundleOptions): Promise<ImportBundleResult> {
  if (options.runtimeType !== "openclaw") {
    throw new Error(`Unsupported runtimeType for import: "${options.runtimeType}"`);
  }

  const layout = resolveRuntimeLayout(
    options.projectDir,
    options.userId,
    options.runtimeType,
    options.runtimeWorkspaceSlug,
  );
  const manifest = await readBackupManifest(options.manifestPath);
  const checksum = `sha256:${await hashFile(options.bundlePath)}`;
  if (checksum !== manifest.checksum) {
    throw new Error(`Bundle checksum mismatch: expected "${manifest.checksum}", got "${checksum}"`);
  }

  const extractBase = await mkdtemp(join(layout.instanceRoot, ".import-extract-"));
  const backupRoot = await mkdtemp(join(layout.instanceRoot, ".import-backup-"));
  const includedPaths = normalizeIncludedPaths(manifest.includedPaths);

  await extractArchive(options.bundlePath, extractBase);
  const restoredFileCount = (await walkFiles(extractBase)).length;

  const movedPaths: string[] = [];
  try {
    // Current MVP semantics are replace-at-directory-boundary, not file-level merge.
    for (const relPath of includedPaths) {
      const target = join(layout.workspaceRoot, relPath);
      const backup = join(backupRoot, relPath);
      if (!await fileExists(target) && !await dirExists(target)) {
        continue;
      }
      await mkdir(dirname(backup), { recursive: true });
      await rename(target, backup);
      movedPaths.push(relPath);
    }

    for (const relPath of includedPaths) {
      const source = join(extractBase, relPath);
      if (!await fileExists(source) && !await dirExists(source)) {
        continue;
      }
      await mkdir(dirname(join(layout.workspaceRoot, relPath)), { recursive: true });
      await cp(source, join(layout.workspaceRoot, relPath), { recursive: true });
    }
  } catch (error) {
    await Promise.all(includedPaths.map(async (relPath) => {
      await removePathIfExists(join(layout.workspaceRoot, relPath));
    }));
    await Promise.all(movedPaths.map(async (relPath) => {
      const backup = join(backupRoot, relPath);
      if (!await fileExists(backup) && !await dirExists(backup)) return;
      await mkdir(dirname(join(layout.workspaceRoot, relPath)), { recursive: true });
      await rename(backup, join(layout.workspaceRoot, relPath));
    }));
    throw error;
  } finally {
    await rm(extractBase, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
  }

  return {
    restoredFileCount,
    bundleChecksum: checksum,
    rebuildRequired: false,
    manifest,
  };
}

export function buildSidecarAttachRuntimeMount(runtimeType: RuntimeType, providerCode: string): string {
  const runtime = getRuntime(runtimeType);
  return `${runtime.containerMountPath}/workspace/runtime/sidecar-${providerCode}`;
}
