import { describe, expect, it } from "bun:test";
import {
  buildRuntimeInstanceEntry,
  redactedRuntimeInstance,
  resolveRuntimeInternalEndpoint,
  runtimeInstanceKey,
} from "../runtime-instance-registry.ts";

describe("runtime instance registry entries", () => {
  it("builds a Hermes entry without plaintext secrets or host paths", () => {
    const entry = buildRuntimeInstanceEntry({
      project: "clawbay",
      userId: "daily",
      runtimeType: "hermes",
      status: "running",
      hostPort: 18642,
      apiKeyRef: "secret:hermes/daily/api-key",
      profileRef: "profile:hermes/daily",
    });

    expect(entry.runtimeInstanceKey).toBe("clawbay:daily");
    expect(entry.internalPort).toBe(8642);
    expect(entry.containerName).toBe("clawbay-daily-hermes");
    expect(entry.endpointRef).toBe("claw-farm:clawbay:daily:endpoint");
    expect(entry.dataVolumeRef).toBe("claw-farm:clawbay:daily:data:hermes");
    expect(entry.workspaceRef).toBe("claw-farm:clawbay:daily:workspace");
    expect(JSON.stringify(entry)).not.toContain("/home/");
    expect(JSON.stringify(entry)).not.toContain("api-key-value");
  });

  it("redacts secret references for public registry views", () => {
    const entry = buildRuntimeInstanceEntry({
      project: "clawbay",
      userId: "daily",
      runtimeType: "hermes",
      status: "running",
      hostPort: 18642,
      apiKeyRef: "secret:hermes/daily/api-key",
      profileRef: "profile:hermes/daily",
    });

    const redacted = redactedRuntimeInstance(entry);
    expect(redacted.apiKeyRef).toBe("ref:***");
    expect(redacted.profileRef).toBe("ref:***");
  });

  it("resolves an internal Docker endpoint without host ports or host paths", () => {
    const entry = buildRuntimeInstanceEntry({
      project: "clawbay",
      userId: "daily",
      runtimeType: "hermes",
      status: "running",
      hostPort: 18642,
      apiKeyRef: "secret:hermes/daily/api-key",
    });

    const endpoint = resolveRuntimeInternalEndpoint(entry);

    expect(endpoint).toEqual({
      endpointRef: "claw-farm:clawbay:daily:endpoint",
      baseUrl: "http://clawbay-daily-hermes:8642",
      exposure: "internal-docker",
    });
    expect(JSON.stringify(endpoint)).not.toContain("18642");
    expect(JSON.stringify(endpoint)).not.toContain("/home/");
    expect(JSON.stringify(endpoint)).not.toContain("secret:");
  });

  it("rejects unsafe runtime instance key components", () => {
    expect(() => runtimeInstanceKey("clawbay", "../daily")).toThrow("Invalid user ID");
  });
});
