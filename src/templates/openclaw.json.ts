/**
 * OpenClaw configuration template.
 * Routes LLM calls through api-proxy (no direct API key access).
 */
export function openclawConfigTemplate(
  name: string,
  processor: "builtin" | "mem0",
  llm: "gemini" | "anthropic" | "openai-compat" = "gemini",
  options?: {
    modelSlug?: string;
    baseUrl?: string | null;
    useProxy?: boolean;
  },
): string {
  const providerConfigs: Record<string, { model: string; providerKey: string; baseUrl: string; directBaseUrl: string; envKey: string }> = {
    gemini: {
      model: "google/gemini-2.5-flash",
      providerKey: "google",
      baseUrl: "http://api-proxy:8080/v1beta",
      directBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      envKey: "GEMINI_API_KEY",
    },
    anthropic: {
      model: "anthropic/claude-sonnet-4-6",
      providerKey: "anthropic",
      baseUrl: "http://api-proxy:8080/v1",
      directBaseUrl: "https://api.anthropic.com/v1",
      envKey: "ANTHROPIC_API_KEY",
    },
    "openai-compat": {
      model: "openai/gpt-4o",
      providerKey: "openai",
      baseUrl: "http://api-proxy:8080/v1",
      directBaseUrl: "https://api.openai.com/v1",
      envKey: "OPENAI_API_KEY",
    },
  };

  const config = providerConfigs[llm];
  const modelSlug = options?.modelSlug?.trim() || config.model;
  const useProxy = options?.useProxy ?? true;
  const hasBaseUrlOverride = Object.prototype.hasOwnProperty.call(options ?? {}, "baseUrl");
  const baseUrl = hasBaseUrlOverride
    ? options?.baseUrl?.trim() || (useProxy ? config.baseUrl : config.directBaseUrl)
    : useProxy ? config.baseUrl : config.directBaseUrl;
  const providerConfig = {
    ...(baseUrl ? { baseUrl } : {}),
    models: [{ id: modelSlug, name: modelSlug }],
  };

  // Output valid JSON (no comments) so JSON.parse works in config merge
  return JSON.stringify(
    {
      agents: {
        defaults: {
          model: {
            primary: modelSlug,
          },
        },
      },
      models: {
        providers: {
          [config.providerKey]: providerConfig,
        },
      },
      ...(useProxy
        ? {
            env: {
              [config.envKey]: "proxied",
            },
          }
        : {}),
      ...(processor === "mem0"
        ? {
            plugins: [
              {
                name: "mem0",
                type: "memory",
                endpoint: "http://mem0-api:8050",
                autoSave: true,
                autoRecall: true,
              },
            ],
          }
        : {}),
      gateway: {
        bind: "lan",
        port: 18789,
        auth: {
          mode: "token",
        },
        http: {
          endpoints: {
            chatCompletions: {
              enabled: true,
            },
            responses: {
              enabled: true,
            },
          },
        },
        controlUi: {
          enabled: false,
        },
      },
    },
    null,
    2,
  ) + "\n";
}
