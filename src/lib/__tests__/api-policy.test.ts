import { describe, expect, it } from "bun:test";
import { shouldPreserveInstanceData } from "../api.ts";

describe("instance data retention policy", () => {
  it("retains Hermes /opt/data by default", () => {
    expect(shouldPreserveInstanceData("hermes")).toBe(true);
  });

  it("requires explicit deleteData to remove Hermes data", () => {
    expect(shouldPreserveInstanceData("hermes", { deleteData: true })).toBe(false);
  });

  it("keeps OpenClaw default behavior unless keepData is requested", () => {
    expect(shouldPreserveInstanceData("openclaw")).toBe(false);
    expect(shouldPreserveInstanceData("openclaw", { keepData: true })).toBe(true);
  });
});
