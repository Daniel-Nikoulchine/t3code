# Providers

**Settings → Providers** on web or desktop holds one environment's provider
setup in a single place: provider instances, model backend connections,
stored API keys, and a read-only model overview. The former Harness tab
redirects here. The mobile app shows these settings read-only.

Provider instances — separate accounts or configurations of one provider —
are set up as described in [Install T3 Code](./install.md#providers) and the
provider guides.

## API keys

Store a vendor's API key once and reference it from any number of
connections. Presets cover Anthropic, OpenAI, Google Gemini, DeepSeek, and
xAI; a free-form vendor name covers the rest. Keys are stored on the server
and never shown again: the app only shows that a key is stored and its last
four characters.

Subscription and OAuth logins do not belong here. They stay bound to the
provider's own CLI login and cannot drive the model router.

## Model backend connections

A connection points at an OpenAI- or Anthropic-compatible model endpoint: a
GLM, DeepSeek, or Kimi gateway, 9Router, LiteLLM, OpenRouter, a local
Ollama, and similar. Each connection declares which of the two wire
protocols it speaks, refers to a stored API key or names an environment
variable holding the key, and can fetch its model list from the endpoint.

Attach a provider instance to a connection and the connection's models
appear on that instance, served by the endpoint instead of the CLI's own
login. Removing a connection returns its instances to their own login.

## Built-in model routing

The server runs a local proxy that provider instances can attach to — pick
**Built-in routing (T3 Router)** in an instance's Provider selector. A
routing rule per model sends requests for that model to a connection or
directly to a vendor API, translating between the OpenAI and Anthropic wire
formats when they differ — streaming and tool calls included. Manage the
rules under Settings → Providers → Routing.

There is no automatic fallback: a failed routed request surfaces its error
to the agent. Subscription-bound models cannot be routed this way — Claude
and Codex subscription models stay exclusive to their own CLI — so routing
across providers needs API keys.

## Which instance serves a model

The **Models** overview lists every model known to the environment and
which provider instances can serve it, including why an instance cannot
yet, such as a missing API key or a vendor lock. On mobile, the model
picker groups by model first, with the serving provider instances
underneath.
