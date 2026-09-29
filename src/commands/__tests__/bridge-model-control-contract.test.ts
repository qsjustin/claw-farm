import { describe, expect, it } from "bun:test";

import { dispatch } from "../bridge.ts";

describe("managed model-control bridge contract", () => {
  it("rejects direct routing before touching runtime state", async () => {
    const result = await dispatch("instance.applyModelControl", {
      project: "clawbay-openclaw",
      userId: "user-1",
      routingMode: "direct",
      apiKey: "sk-user-provider-key",
      modelSlug: "openai/custom"
    });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid-payload");
    expect(result.message).toContain('routingMode must be "litellm"');
  });
});
