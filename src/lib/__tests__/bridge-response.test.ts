import { describe, expect, it } from "bun:test";
import {
  buildRuntimeInstanceKey,
  buildRuntimeWorkspaceSlug,
  createBridgeFailure,
  createBridgeSuccess,
} from "../bridge-response.ts";

describe("bridge-response", () => {
  it("builds contract-shaped success payloads with runtime identifiers", () => {
    const response = createBridgeSuccess({
      action: "instance.create",
      message: "Created runtime workspace",
      observedAt: "2026-04-22T00:00:00.000Z",
      project: "demo",
      userId: "alice",
      runtimeState: "running",
      metadata: { composeProject: "demo-alice" },
      extra: { port: 18789 },
    });

    expect(response).toEqual({
      ok: true,
      action: "instance.create",
      message: "Created runtime workspace",
      observedAt: "2026-04-22T00:00:00.000Z",
      runtimeState: "running",
      runtimeInstanceKey: "demo:alice",
      runtimeWorkspaceSlug: "alice",
      metadata: { composeProject: "demo-alice" },
      port: 18789,
    });
  });

  it("defaults retryable based on error code and preserves message as error alias", () => {
    const response = createBridgeFailure({
      action: "instance.sync",
      message: "docker compose ps failed",
      observedAt: "2026-04-22T00:00:00.000Z",
      project: "demo",
      userId: "alice",
      errorCode: "runtime-command-failed",
    });

    expect(response.ok).toBe(false);
    expect(response.retryable).toBe(true);
    expect(response.error).toBe("docker compose ps failed");
    expect(response.runtimeInstanceKey).toBe("demo:alice");
    expect(response.runtimeWorkspaceSlug).toBe("alice");
  });

  it("builds stable runtime identifiers", () => {
    expect(buildRuntimeInstanceKey("demo", "alice")).toBe("demo:alice");
    expect(buildRuntimeWorkspaceSlug("alice")).toBe("alice");
  });
});
