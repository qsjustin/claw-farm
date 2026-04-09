/**
 * picoclaw configuration template.
 * Routes LLM calls through api-proxy (no direct API key access).
 *
 * Required fields discovered from picoclaw v0.2.4 config migration:
 * - model_list[].model: "provider/model_name" format (routing key)
 * - model_list[].model_name: must match agents.defaults.model_name
 * - agents.defaults.provider: provider name for model routing
 * - channels.pico.enabled: true (at least one channel must be active)
 */
export function picoClawConfigTemplate(
  _name: string,
  _processor: "builtin" | "mem0",
  llm: "gemini" | "anthropic" | "openai-compat" = "gemini",
  options?: {
    modelSlug?: string;
    baseUrl?: string | null;
  },
): string {
  const providerConfigs: Record<string, {
    modelName: string;
    model: string;
    provider: string;
    apiBase: string;
  }> = {
    gemini: {
      modelName: "gemini-2.5-flash",
      model: "gemini/gemini-2.5-flash",
      provider: "gemini",
      apiBase: "http://api-proxy:8080/v1beta",
    },
    anthropic: {
      modelName: "claude-sonnet-4-6",
      model: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      apiBase: "http://api-proxy:8080/v1",
    },
    "openai-compat": {
      modelName: "gpt-4o",
      model: "openai/gpt-4o",
      provider: "openai",
      apiBase: "http://api-proxy:8080/v1",
    },
  };

  const config = providerConfigs[llm];
  const modelName = options?.modelSlug?.trim() || config.modelName;
  const model = options?.modelSlug?.trim()
    ? (llm === "gemini" ? `gemini/${modelName}` : llm === "anthropic" ? `anthropic/${modelName}` : `openai/${modelName}`)
    : config.model;
  const apiBase = options?.baseUrl?.trim() || config.apiBase;

  return JSON.stringify(
    {
      version: 1,
      session: {
        dm_scope: "per-channel-peer",
      },
      agents: {
        defaults: {
          workspace: "/root/.picoclaw/workspace",
          restrict_to_workspace: true,
          provider: config.provider,
          model_name: modelName,
          max_tokens: 4096,
          temperature: 0.7,
          max_tool_iterations: 50,
          summarize_message_threshold: 20,
          summarize_token_percent: 75,
        },
      },
      channels: {
        pico: {
          enabled: true,
          allow_from: [],
        },
      },
      model_list: [
        {
          model_name: modelName,
          model: model,
          api_base: apiBase,
          api_key: "proxied",
        },
      ],
      gateway: {
        host: "0.0.0.0",
        port: 18790,
        log_level: "info",
      },
      tools: {
        read_file: { enabled: true },
        write_file: { enabled: true },
        edit_file: { enabled: true },
        list_dir: { enabled: true },
        append_file: { enabled: true },
        skills: { enabled: true },
        find_skills: { enabled: true },
      },
    },
    null,
    2,
  ) + "\n";
}
