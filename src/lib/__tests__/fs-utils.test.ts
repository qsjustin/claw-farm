import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileExists, copyIfExists, dirExists } from "../fs-utils.ts";

let tmp: string;

beforeEach(async () => {
  tmp = join(tmpdir(), `claw-farm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmp, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("fileExists", () => {
  it("returns true for an existing file", async () => {
    const p = join(tmp, "hello.txt");
    await writeFile(p, "hi");
    expect(await fileExists(p)).toBe(true);
  });

  it("returns false for a missing file", async () => {
    expect(await fileExists(join(tmp, "no-such-file.txt"))).toBe(false);
  });
});

describe("copyIfExists", () => {
  it("copies file when source exists", async () => {
    const src = join(tmp, "src.txt");
    const dest = join(tmp, "dest.txt");
    await writeFile(src, "content");
    await copyIfExists(src, dest);
    expect(await fileExists(dest)).toBe(true);
    expect(await Bun.file(dest).text()).toBe("content");
  });

  it("silently no-ops when source does not exist", async () => {
    const src = join(tmp, "nonexistent.txt");
    const dest = join(tmp, "dest.txt");
    await copyIfExists(src, dest);
    expect(await fileExists(dest)).toBe(false);
  });
});

describe("dirExists", () => {
  it("returns true for an existing directory", async () => {
    const dir = join(tmp, "subdir");
    await mkdir(dir);
    expect(await dirExists(dir)).toBe(true);
  });

  it("returns false when path is a file, not a directory", async () => {
    const p = join(tmp, "file.txt");
    await writeFile(p, "x");
    expect(await dirExists(p)).toBe(false);
  });

  it("returns false for a missing path", async () => {
    expect(await dirExists(join(tmp, "no-such-dir"))).toBe(false);
  });
});
