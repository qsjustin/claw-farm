import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildRuntimeRegistrySyncExtra } from "../bridge.ts";
import { buildRuntimeInstanceEntry, redactedRuntimeInstance } from "../../lib/runtime-instance-registry.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

async function source(relPath: string): Promise<string> {
  return Bun.file(join(repoRoot, relPath)).text();
}

describe("runtime registry command integration", () => {
  it("keeps CLI up/down paths wired to runtime registry status updates", async () => {
    const upSource = await source("src/commands/up.ts");
    const downSource = await source("src/commands/down.ts");

    expect(upSource).toContain("updateRuntimeInstanceStatus");
    expect(upSource).toContain('"running"');
    expect(downSource).toContain("updateRuntimeInstanceStatus");
    expect(downSource).toContain('"stopped"');
  });

  it("does not expose host compose paths in runtime.registry.sync extra", () => {
    const entry = redactedRuntimeInstance(buildRuntimeInstanceEntry({
      project: "clawbay",
      userId: "daily",
      runtimeType: "hermes",
      status: "running",
      hostPort: 18642,
      apiKeyRef: "secret:hermes/daily/api-key",
    }));
    const extra = buildRuntimeRegistrySyncExtra({
      composeProject: "clawbay-daily",
      runtimeInstance: entry,
    });
    const serialized = JSON.stringify(extra);

    expect(extra).toEqual({
      composeProject: "clawbay-daily",
      runtimeInstance: entry,
    });
    expect(serialized).not.toContain("composePath");
    expect(serialized).not.toContain("/home/");
  });

  it("source supports three-part runtimeInstanceKey parsing and internal endpoint resolve output", async () => {
    const bridgeSource = await source("src/commands/bridge.ts");

    expect(bridgeSource).toContain('"project:userId" or "project:userId:runtimeType"');
    expect(bridgeSource).toContain("resolveRuntimeInternalEndpoint(entry)");
  });
});
