/**
 * Curated provider templates for the global model-backend card.
 *
 * Every entry is an OpenAI-compatible `/v1` endpoint (or blank, for custom
 * and generic gateways): only URLs and key-variable *names* live here — no
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
  readonly hint: string;
  /** False for keyless local runtimes (Ollama, LM Studio) and blank slates. */
  readonly needsKey: boolean;
}

/**
 * Template list for the provider picker list. `custom` is the blank
 * starting point; `gateway` stays URL-less because every LiteLLM/OmniRoute
 * deployment has its own host. Gemini is intentionally absent: its
 * OpenAI-compatible route does not end in `/v1` and its key-variable naming
 * is ambiguous — use `custom` with the documented URL instead.
 *
 * The list is pick-only: tapping a row prefills the add-connection form
 * (see web `AddBackendConnectionDialog`). There is deliberately no
 * saved-URL-to-preset matcher — only added connections render, so no row
 * ever needs an active state.
 */
export const PROVIDER_PRESET_LIST: ReadonlyArray<ModelProviderPreset> = [
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    hint: "Blank starting point for any OpenAI-compatible endpoint (native Anthropic APIs don't fit here — keep the Claude harness on direct login).",
    needsKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    hint: "API key from the OpenAI dashboard; only the variable name is stored.",
    needsKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    hint: "API key from your OpenRouter account; one key reaches many models.",
    needsKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    hint: "API key from the DeepSeek platform.",
    needsKey: true,
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    hint: "API key from the xAI console.",
    needsKey: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    hint: "API key from the Mistral console (La Plateforme).",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    hint: "Local only with no key needed; remote environments need a URL reachable from that machine, not localhost.",
    needsKey: false,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    hint: "Local only with no key needed; remote environments need a URL reachable from that machine, not localhost.",
    needsKey: false,
  },
  {
    id: "gateway",
    label: "Generic gateway",
    baseUrl: "",
    hint: "Generic gateway such as LiteLLM or OmniRoute — enter its URL with the /v1 prefix and your key's variable name.",
    needsKey: true,
  },
];
