import { afterEach, describe, expect, it } from "bun:test";
import { dockerNetworkConnect } from "../compose.ts";

const originalSpawn = Bun.spawn;

function mockSpawn(exitCode: number, stderr = "") {
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
    exited: Promise.resolve(exitCode),
    stdout: new Blob([""]).stream(),
    stderr: new Blob([stderr]).stream(),
  })) as unknown as typeof Bun.spawn;
}

afterEach(() => {
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
});

describe("docker network connect", () => {
  it("throws for required runtime attach networks", async () => {
    mockSpawn(1, "Error response from daemon: network /home/ubuntu/missing not found");

    await expect(
      dockerNetworkConnect("missing-network", "runtime-container", {
        quiet: true,
        required: true,
      }),
    ).rejects.toThrow("required runtime network");

    await expect(
      dockerNetworkConnect("missing-network", "runtime-container", {
        quiet: true,
        required: true,
      }),
    ).rejects.not.toThrow("/home/ubuntu");
  });

  it("keeps best-effort behavior for non-required network connects", async () => {
    mockSpawn(1, "Error response from daemon: network missing not found");

    await expect(
      dockerNetworkConnect("missing-network", "shared-proxy", {
        quiet: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("treats already connected containers as success", async () => {
    mockSpawn(1, "Error response from daemon: endpoint with name runtime-container already exists");

    await expect(
      dockerNetworkConnect("clawbay_default", "runtime-container", {
        quiet: true,
        required: true,
      }),
    ).resolves.toBeUndefined();
  });
});
