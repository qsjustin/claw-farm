/**
 * #159B: Port allocator tests — verify weixinSidecarPort is collected
 * and allocated ports don't collide with existing sidecar ports.
 */

import { describe, it, expect } from "bun:test";
import { allocatePort, type Registry, type InstanceEntry } from "../registry.ts";

function makeInstance(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
  return {
    userId: "test-user",
    port: 18800,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("allocatePort — weixinSidecarPort collection (#159B)", () => {
  it("allocates a port that does not collide with existing weixinSidecarPorts", () => {
    const reg: Registry = {
      projects: {
        "test-proj": {
          path: "/tmp/test",
          port: 18789,
          processor: "builtin",
          createdAt: new Date().toISOString(),
          multiInstance: true,
          runtime: "hermes",
          instances: {
            "user-1": makeInstance({ port: 18800, weixinSidecarPort: 18801 }),
            "user-2": makeInstance({ port: 18802, weixinSidecarPort: 18803 }),
          },
        },
      },
      nextPort: 18804,
    };

    const port = allocatePort(reg);
    // Should allocate 18804 (nextPort) — not collide with any existing port
    expect(port).toBe(18804);
    expect(reg.nextPort).toBe(18805);
  });

  it("skips ports already used by weixinSidecarPort when allocating", () => {
    const reg: Registry = {
      projects: {
        "test-proj": {
          path: "/tmp/test",
          port: 18789,
          processor: "builtin",
          createdAt: new Date().toISOString(),
          multiInstance: true,
          runtime: "hermes",
          instances: {
            "user-1": makeInstance({ port: 18800, weixinSidecarPort: 18801 }),
          },
        },
      },
      // nextPort is 18801 which is already a sidecar port — should skip to 18802
      nextPort: 18801,
    };

    const port = allocatePort(reg);
    expect(port).toBe(18802);
  });

  it("skips ports already used by weixinSidecarPort when allocating (collision in middle)", () => {
    const reg: Registry = {
      projects: {
        "test-proj": {
          path: "/tmp/test",
          port: 18789,
          processor: "builtin",
          createdAt: new Date().toISOString(),
          multiInstance: true,
          runtime: "hermes",
          instances: {
            "user-1": makeInstance({ port: 18800, weixinSidecarPort: 18802 }),
          },
        },
      },
      // nextPort=18801 is free, but 18802 is a sidecar port
      nextPort: 18801,
    };

    const port = allocatePort(reg);
    expect(port).toBe(18801); // 18801 is free, should allocate it

    // Next allocation should skip 18802 (sidecar port)
    reg.nextPort = 18802;
    const port2 = allocatePort(reg);
    expect(port2).toBe(18803); // skips 18802
  });

  it("handles instances without weixinSidecarPort (old instances)", () => {
    const reg: Registry = {
      projects: {
        "test-proj": {
          path: "/tmp/test",
          port: 18789,
          processor: "builtin",
          createdAt: new Date().toISOString(),
          multiInstance: true,
          runtime: "hermes",
          instances: {
            "old-user": makeInstance({ port: 18800 }), // no weixinSidecarPort
            "new-user": makeInstance({ port: 18801, weixinSidecarPort: 18802 }),
          },
        },
      },
      nextPort: 18803,
    };

    const port = allocatePort(reg);
    expect(port).toBe(18803);
  });
});
