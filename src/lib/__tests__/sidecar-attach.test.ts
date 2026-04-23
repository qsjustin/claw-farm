import { describe, expect, it } from "bun:test";
import { resolveSidecarAttachPoint } from "../sidecar-attach.ts";

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
});
