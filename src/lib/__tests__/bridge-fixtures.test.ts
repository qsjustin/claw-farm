import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeErrorCode, BridgeResponse } from "../bridge-response.ts";

const fixtureRoot = join(process.cwd(), "tests", "fixtures");
const requiredErrorCodes: BridgeErrorCode[] = [
  "adapter-unavailable",
  "invalid-operation",
  "invalid-payload",
  "runtime-missing",
  "runtime-conflict",
  "runtime-command-failed",
  "unknown",
];
const requiredSuccessActions = [
  "agent.create",
  "agent.updateConfig",
  "instance.applyModelControl",
  "instance.create",
  "instance.delete",
  "instance.export",
  "instance.import",
  "instance.restart",
  "instance.start",
  "instance.stop",
  "instance.sync",
];

async function loadFixtures(group: "success" | "errors"): Promise<Array<{ name: string; value: BridgeResponse }>> {
  const dir = join(fixtureRoot, group);
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => ({
      name: file,
      value: JSON.parse(await readFile(join(dir, file), "utf8")) as BridgeResponse,
    })),
  );
}

describe("bridge fixtures", () => {
  test("success fixtures use the bridge response envelope", async () => {
    const fixtures = await loadFixtures("success");
    const actions = new Set(fixtures.map(({ value }) => value.action));

    for (const action of requiredSuccessActions) {
      expect(actions.has(action), action).toBe(true);
    }

    for (const { name, value } of fixtures) {
      expect(value.ok, name).toBe(true);
      expect(value.action, name).toBeTruthy();
      expect(value.message, name).toBeTruthy();
      expect(value.observedAt, name).toBeTruthy();
    }
  });

  test("error fixtures cover every bridge error code", async () => {
    const fixtures = await loadFixtures("errors");
    const codes = new Set(fixtures.map(({ value }) => (value.ok ? undefined : value.errorCode)));

    for (const code of requiredErrorCodes) {
      expect(codes.has(code), code).toBe(true);
    }

    for (const { name, value } of fixtures) {
      expect(value.ok, name).toBe(false);
      if (!value.ok) {
        expect(value.error, name).toBeTruthy();
        expect(typeof value.retryable, name).toBe("boolean");
      }
    }
  });
});
