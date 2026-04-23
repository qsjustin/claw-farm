import { exportInstanceBundle, type ExportBundleOptions, type ExportBundleResult } from "../lib/backup-bundle.ts";

export type { ExportBundleOptions, ExportBundleResult };

export async function exportCommand(options: ExportBundleOptions): Promise<ExportBundleResult> {
  return exportInstanceBundle(options);
}
