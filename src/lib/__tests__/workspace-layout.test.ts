import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import {
  ensureWorkspaceLayout,
  resolveWorkspaceLayout,
  validateWorkspaceLayout,
  WORKSPACE_LAYOUT_DIRS,
} from "../workspace-layout.ts";

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-workspace-layout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("workspace-layout", () => {
  it("creates the standardized workspace directories for an instance", async () => {
    const layout = resolveWorkspaceLayout(tmp, "alice", "openclaw");
    await ensureWorkspaceLayout(layout);

    const validation = await validateWorkspaceLayout(layout);
    expect(validation).toEqual({ ok: true, missing: [] });
    expect(layout.runtimeWorkspaceSlug).toBe("alice");
  });

  it("reports missing layout directories", async () => {
    const layout = resolveWorkspaceLayout(tmp, "alice", "openclaw");
    await mkdir(layout.workspaceRoot, { recursive: true });
    await mkdir(layout.skillsDir, { recursive: true });

    const validation = await validateWorkspaceLayout(layout);
    expect(validation.ok).toBe(false);
    expect(validation.missing).toEqual(
      WORKSPACE_LAYOUT_DIRS.filter((dir) => dir !== "skills"),
    );
  });
});
