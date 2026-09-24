/**
 * Curated provider templates for the global model-backend card.
 *
 * Every entry is an OpenAI-compatible `/v1` endpoint (or blank, for the
 * custom starting point): only URLs and key-variable *names* live here — no
 * key values, no quota or pricing info, no OAuth. Native Anthropic endpoints
 * are deliberately absent (not OpenAI-compatible); the Claude harness stays
 * on direct login for those.
 *
 * @module modelProviderPresets
 */
export interface ModelProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string | undefined;
  /** False for the blank custom slate. */
  readonly needsKey: boolean;
}

/**
 * Template list for the provider picker list. `custom` is the last option:
 * the blank starting point for any other endpoint (including gateways such
 * as a GLM or Kimi gateway, 9Router, LiteLLM, OpenRouter, a local
 * Ollama, and similar — their hosts all differ). Gemini is intentionally
 * absent: its OpenAI-compatible route does not end in `/v1` and its
 * key-variable naming is ambiguous — use `custom` with the documented URL
 * instead.
 *
 * The list is pick-only: tapping a row prefills the add-connection form
 * (see web `AddBackendConnectionDialog`). There is deliberately no
 * saved-URL-to-preset matcher — only added connections render, so no row
 * ever needs an active state.
 */
export const PROVIDER_PRESET_LIST: ReadonlyArray<ModelProviderPreset> = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    needsKey: true,
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    needsKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    needsKey: true,
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    needsKey: true,
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    needsKey: true,
  },
  {
    id: "codebuff",
    label: "Codebuff",
    baseUrl: "https://www.codebuff.com/api/v1",
    apiKeyEnv: "CODEBUFF_API_KEY",
    needsKey: true,
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    needsKey: false,
  },
];
