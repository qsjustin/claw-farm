#!/usr/bin/env bun
/**
 * Build script for claw-farm package distribution.
 *
 * Generates JS bundles (via bun build) and .d.ts declarations (via tsc)
 * so that tsc-based consumers can import without allowImportingTsExtensions.
 *
 * Bun consumers still use raw .ts via conditional exports ("bun" condition).
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const DIST = "dist";

// Derive entry points from package.json exports (single source of truth)
const pkg = await Bun.file("package.json").json();
const ENTRY_POINTS = Object.values(pkg.exports as Record<string, { bun: string; default: string }>).map(
  (exp) => ({
    entry: exp.bun,
    outdir: exp.default.replace(/\/[^/]+$/, ""),
  }),
);

// 1. Clean dist/
await rm(DIST, { recursive: true, force: true });

// 2. Build JS bundles + generate .d.ts declarations in parallel
const [results, tsc] = await Promise.all([
  Promise.all(
    ENTRY_POINTS.map(({ entry, outdir }) =>
      Bun.build({
        entrypoints: [entry],
        outdir,
        target: "node",
        format: "esm",
        packages: "external",
        naming: "[name].js",
      }),
    ),
  ),
  $`bunx tsc -p tsconfig.build.json`.quiet().nothrow(),
]);

for (let i = 0; i < results.length; i++) {
  if (!results[i].success) {
    console.error(`Build failed for ${ENTRY_POINTS[i].entry}:`, results[i].logs);
    process.exit(1);
  }
}

if (tsc.exitCode !== 0) {
  console.warn("⚠ tsc declaration generation skipped (tsc unavailable)");
  console.warn(tsc.stderr.toString());
} else {
  // 3. Post-process .d.ts files: rewrite .ts import extensions to .js
  //    so consumers without allowImportingTsExtensions can resolve them.
  await fixDtsExtensions(DIST);
}

console.log("Build complete.");

async function fixDtsExtensions(dir: string): Promise<void> {
  const files = await readdir(dir, { recursive: true });
  await Promise.all(
    files
      .filter((f) => f.endsWith(".d.ts"))
      .map(async (rel) => {
        const fullPath = join(dir, rel);
        const content = await Bun.file(fullPath).text();
        const fixed = content.replace(
          /((?:from|import\()\s*["'][^"']+)\.ts(["'])/g,
          "$1.js$2",
        );
        if (fixed !== content) {
          await Bun.write(fullPath, fixed);
        }
      }),
  );
}
