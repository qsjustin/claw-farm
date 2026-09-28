import { describe, expect, it } from "bun:test";

import { dispatch } from "../bridge.ts";

describe("bridge capabilities", () => {
  it("exposes model-control routing capability at the top level", async () => {
    const result = await dispatch("bridge.capabilities", {});

    expect(result.ok).toBe(true);
    expect(result.capabilities).toContain("model-control-routing-v2");
    expect(result).not.toHaveProperty("extra");
  });
});
