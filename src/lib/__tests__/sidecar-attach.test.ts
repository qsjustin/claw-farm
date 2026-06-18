import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureDefaultSidecarAttachPoints,
  resolveSidecarAttachPoint,
} from "../sidecar-attach.ts";
import { ensureWorkspaceLayout, resolveWorkspaceLayout } from "../workspace-layout.ts";

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-sidecar-attach-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("sidecar-attach", () => {
  it("builds standardized attach point metadata", () => {
    const attach = resolveSidecarAttachPoint({
      workspaceRoot: "/tmp/workspace",
      runtimeWorkspaceSlug: "workspace-1",
      providerCode: "weixin",
      sidecarCode: "weixin-auth-sidecar",
      runtimeType: "openclaw",
    });

    expect(attach.configDir).toBe("/tmp/workspace/runtime/sidecar-weixin");
    expect(attach.runtimeHandle).toBe("workspace-1:weixin-auth-sidecar");
    expect(attach.healthEndpoint).toBe("${WEIXIN_SIDECAR_URL}/healthz");
    expect(attach.runtimeMountPath).toBe("/home/node/.openclaw/workspace/runtime/sidecar-weixin");
  });

  it("bootstraps the default weixin attach point for new workspaces", async () => {
    const layout = resolveWorkspaceLayout(tmp, "alice", "openclaw");
    await ensureWorkspaceLayout(layout);

    const attachPoints = await ensureDefaultSidecarAttachPoints({
      layout,
      runtimeType: "openclaw",
    });

    expect(attachPoints).toHaveLength(1);
    const descriptor = JSON.parse(
      await readFile(join(layout.runtimeDataDir, "sidecar-weixin", "attach-point.json"), "utf8"),
    ) as { runtimeHandle: string; sidecarCode: string };

    expect(descriptor.runtimeHandle).toBe("alice:weixin-auth-sidecar");
    expect(descriptor.sidecarCode).toBe("weixin-auth-sidecar");
  });

  it("#159B: pre-creates openclaw and weixin-sessions subdirs for sidecar data mount", async () => {
    const layout = resolveWorkspaceLayout(tmp, "bob", "hermes");
    await ensureWorkspaceLayout(layout);

    await ensureDefaultSidecarAttachPoints({
      layout,
      runtimeType: "hermes",
    });

    // The sidecar mounts configDir as /data and needs these subdirs
    const sidecarDir = join(layout.runtimeDataDir, "sidecar-weixin");
    const openclawDir = await readFile(join(sidecarDir, "openclaw"), "utf8").catch(() => null);
    const sessionsDir = await readFile(join(sidecarDir, "weixin-sessions"), "utf8").catch(() => null);

    // Directories should exist (readFile will fail for dirs, but stat should succeed)
    const { stat } = await import("node:fs/promises");
    const openclawStat = await stat(join(sidecarDir, "openclaw")).catch(() => null);
    const sessionsStat = await stat(join(sidecarDir, "weixin-sessions")).catch(() => null);

    expect(openclawStat?.isDirectory()).toBe(true);
    expect(sessionsStat?.isDirectory()).toBe(true);
  });
});
