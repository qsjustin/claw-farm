import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyInstanceModelControl } from "../api.ts";
import { saveRegistry } from "../registry.ts";

async function createRegisteredInstance(input: {
  runtime: "openclaw" | "hermes";
  projectName: string;
  userId: string;
}) {
  const root = await mkdtemp(join(tmpdir(), `claw-farm-${input.runtime}-routing-`));
  const registryDir = join(root, "registry");
  const projectDir = join(root, "project");
  const instDir = join(projectDir, "instances", input.userId);
  const runtimeDir = join(instDir, input.runtime);
  const originalRegistryDir = process.env.CLAW_FARM_REGISTRY_DIR;

  process.env.CLAW_FARM_REGISTRY_DIR = registryDir;
  await mkdir(runtimeDir, { recursive: true });
  await saveRegistry({
    nextPort: 20000,
    projects: {
      [input.projectName]: {
        path: projectDir,
        port: 19999,
        processor: "builtin",
        createdAt: "2026-09-28T00:00:00.000Z",
        multiInstance: true,
        runtime: input.runtime,
        instances: {
          [input.userId]: {
            userId: input.userId,
            port: 20001,
            createdAt: "2026-09-28T00:00:00.000Z",
          },
        },
      },
    },
  });

  return {
    root,
    projectDir,
    instDir,
    runtimeDir,
    restoreEnv() {
      if (originalRegistryDir === undefined) {
        delete process.env.CLAW_FARM_REGISTRY_DIR;
      } else {
        process.env.CLAW_FARM_REGISTRY_DIR = originalRegistryDir;
      }
    },
  };
}

describe("model-control routing apply", () => {
  it("normalizes LiteLLM routes to OpenAI-compatible OpenClaw config", async () => {
    const fixture = await createRegisteredInstance({
      runtime: "openclaw",
      projectName: "clawbay-openclaw",
      userId: "user-1",
    });

    try {
      await applyInstanceModelControl({
        project: "clawbay-openclaw",
        userId: "user-1",
        llm: "gemini",
        apiKey: "sk-litellm-vk-test",
        routingMode: "litellm",
        routingEndpoint: "http://litellm:4000/v1",
        modelSlug: "gemini/gemini-2.5-flash",
      });

      const modelEnv = await readFile(join(fixture.instDir, ".env.model"), "utf8");
      expect(modelEnv).toContain("LLM_PROVIDER=openai-compat");
      expect(modelEnv).toContain("OPENAI_API_KEY=sk-litellm-vk-test");
      expect(modelEnv).toContain("OPENAI_COMPAT_BASE_URL=http://litellm:4000/v1");
      expect(modelEnv).toContain("GEMINI_API_KEY=");
      expect(modelEnv).not.toContain("GEMINI_API_KEY=sk-litellm-vk-test");

      const openclawConfig = JSON.parse(
        await readFile(join(fixture.runtimeDir, "openclaw.json"), "utf8"),
      ) as {
        models: { providers: Record<string, { baseUrl?: string; models: Array<{ id: string }> }> };
        agents: { defaults: { model: { primary: string } } };
      };

      expect(openclawConfig.agents.defaults.model.primary).toBe("gemini/gemini-2.5-flash");
      expect(openclawConfig.models.providers.openai?.baseUrl).toBe("http://litellm:4000/v1");
      expect(openclawConfig.models.providers.openai?.models[0]?.id).toBe("gemini/gemini-2.5-flash");
      expect(openclawConfig.models.providers.google).toBeUndefined();
    } finally {
      fixture.restoreEnv();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes DeepSeek LiteLLM routes without writing provider credentials to the runtime", async () => {
    const fixture = await createRegisteredInstance({
      runtime: "openclaw",
      projectName: "clawbay-openclaw",
      userId: "user-1",
    });

    try {
      await applyInstanceModelControl({
        project: "clawbay-openclaw",
        userId: "user-1",
        llm: "openai-compat",
        apiKey: "sk-litellm-vk-deepseek",
        routingMode: "litellm",
        routingEndpoint: "http://litellm:4000/v1",
        modelSlug: "deepseek-chat",
      });

      const modelEnv = await readFile(join(fixture.instDir, ".env.model"), "utf8");
      expect(modelEnv).toContain("MODEL_ROUTING_MODE=litellm");
      expect(modelEnv).toContain("MODEL_ID=deepseek-chat");
      expect(modelEnv).toContain("LLM_PROVIDER=openai-compat");
      expect(modelEnv).toContain("OPENAI_API_KEY=sk-litellm-vk-deepseek");
      expect(modelEnv).toContain("OPENAI_COMPAT_BASE_URL=http://litellm:4000/v1");
      expect(modelEnv).not.toContain("DEEPSEEK_API_KEY=");

      const openclawConfig = JSON.parse(
        await readFile(join(fixture.runtimeDir, "openclaw.json"), "utf8"),
      ) as {
        models: { providers: Record<string, { baseUrl?: string; models: Array<{ id: string }> }> };
        agents: { defaults: { model: { primary: string } } };
      };

      expect(openclawConfig.agents.defaults.model.primary).toBe("deepseek-chat");
      expect(openclawConfig.models.providers.openai?.baseUrl).toBe("http://litellm:4000/v1");
      expect(openclawConfig.models.providers.openai?.models[0]?.id).toBe("deepseek-chat");
      expect(openclawConfig.models.providers.google).toBeUndefined();
    } finally {
      fixture.restoreEnv();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes LiteLLM routes to Hermes custom provider config", async () => {
    const fixture = await createRegisteredInstance({
      runtime: "hermes",
      projectName: "clawbay-hermes",
      userId: "user-1",
    });

    try {
      await writeFile(
        join(fixture.runtimeDir, "config.yaml"),
        [
          'provider: "gemini"',
          'default: "google/gemini-2.5-flash"',
          'base_url: "https://generativelanguage.googleapis.com/v1beta"',
          "",
        ].join("\n"),
      );

      await applyInstanceModelControl({
        project: "clawbay-hermes",
        userId: "user-1",
        llm: "gemini",
        apiKey: "sk-litellm-vk-test",
        routingMode: "litellm",
        routingEndpoint: "http://litellm:4000/v1",
        modelSlug: "gemini/gemini-2.5-flash",
      });

      const metadata = JSON.parse(
        await readFile(join(fixture.runtimeDir, ".claw-farm-hermes.json"), "utf8"),
      ) as { llm: string; modelSlug: string; baseUrl: string };
      expect(metadata.llm).toBe("openai-compat");
      expect(metadata.modelSlug).toBe("gemini/gemini-2.5-flash");
      expect(metadata.baseUrl).toBe("http://litellm:4000/v1");

      const hermesConfig = await readFile(join(fixture.runtimeDir, "config.yaml"), "utf8");
      expect(hermesConfig).toContain('provider: "custom"');
      expect(hermesConfig).toContain('default: "gemini/gemini-2.5-flash"');
      expect(hermesConfig).toContain('base_url: "http://litellm:4000/v1"');
    } finally {
      fixture.restoreEnv();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
