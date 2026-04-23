import { importInstanceBundle, type ImportBundleOptions, type ImportBundleResult } from "../lib/backup-bundle.ts";

export type { ImportBundleOptions, ImportBundleResult };

export async function importCommand(options: ImportBundleOptions): Promise<ImportBundleResult> {
  return importInstanceBundle(options);
}
