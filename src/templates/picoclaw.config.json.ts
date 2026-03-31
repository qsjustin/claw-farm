/**
 * picoclaw configuration template.
 * Routes LLM calls through api-proxy (no direct API key access).
 */
export function picoClawConfigTemplate(
  _name: string,
  _processor: "builtin" | "mem0",
  llm: "gemini" | "anthropic" | "openai-compat" = "gemini",
): string {
  const providerConfigs: Record<string, { model: string; provider: string; apiBase: string }> = {
    gemini: {
      model: "gemini-2.5-flash",
      provider: "gemini",
      apiBase: "http://api-proxy:8080/v1beta",
    },
    anthropic: {
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      apiBase: "http://api-proxy:8080/v1",
    },
    "openai-compat": {
      model: "gpt-4o",
      provider: "openai",
      apiBase: "http://api-proxy:8080/v1",
    },
  };

  const config = providerConfigs[llm];

  return JSON.stringify(
    {
      agents: {
        defaults: {
          workspace: "/root/.picoclaw/workspace",
          model: config.model,
          max_tokens: 4096,
          temperature: 0.7,
        },
      },
      model_list: [
        {
          provider: config.provider,
          api_base: config.apiBase,
          api_key: "proxied",
        },
      ],
      gateway: {
        host: "0.0.0.0",
        port: 18790,
        log_level: "info",
      },
    },
    null,
    2,
  ) + "\n";
}
