# Providers

**Settings → Providers** on web or desktop holds one environment's shared
model backend setup: the **API providers** (model backend connections)
harness instances can run on, the **usage providers** (quota hubs), and the
provider probe interval under **Advanced**. Harness instances themselves
live on **Settings → Harness**: each harness card is the full settings for
one instance — **Display**, **Setup**, **Sign in**, **Connection**,
**Models**, **Runtime**, and **Environment** — including per-model
toggles. Nothing on the Harness tab configures a shared backend, and
nothing on the Providers tab configures one harness. Subscription and OAuth
logins stay bound to each harness's own CLI login. The mobile app shows
these settings read-only.

Each harness card picks _what_ you work with (the harness — Codex, Claude,
Cline, and the rest) and _what it runs on_ (its own login or a shared API
connection) in one place. One connection can serve any number of
instances: create it with **Add provider** on the Providers tab, then pick
it per instance under **Connection** on the Harness tab. Deleting a
connection returns its instances to their own login.

## Sign in

Antigravity signs in from inside T3 Code via its Setup section. Every other
harness signs in through its own CLI on the environment — usually an OAuth
browser flow. Each harness card's **Sign in** section shows that login
command (for example `codex login` or `claude auth login`) with a copy
button and a **Check again** button that re-probes the login state after you
ran it. Signing in without a terminal is offered where a provider is added:
**Settings → Providers**, **Add provider** can run the vendor's own browser
flow (ChatGPT device code, Claude browser + pasted code) for a Codex or
Claude harness. T3 Code only reads the resulting state back; the OAuth
token never enters settings, the key store, or the router.

Provider instances — separate accounts or configurations of one provider —
are set up as described in [Install T3 Code](./install.md#providers) and the
provider guides.

## Permissions

File edits and commands go through T3 Code's permission UI, whose buttons
offer the harness's own choices. Automatic approval prefers the
session-scoped choice and never silently creates a permanent grant. Full
access starts the harness with auto-approval enabled and bypasses per-turn
prompts — only use it in isolated environments. Each provider guide lists
how T3 Code's modes map onto that harness.

## API providers

A connection points at an OpenAI- or Anthropic-compatible model endpoint.
**Add provider** offers templates for OpenAI, xAI, DeepSeek, OpenCode Zen/Go,
and Codebuff plus **Custom** for everything else — a GLM or Kimi gateway, 9Router, LiteLLM,
OpenRouter, a local Ollama, and similar. API protocols are detected automatically
when saving. If a reachable gateway cannot be identified, existing protocol
settings are preserved; new connections use the compatibility default of both.
Each connection either references a stored API key — created
inline with **New key** in the Add-provider dialog, stored on the server
and never shown again — or names an environment variable holding the key.
It can fetch its model list from the endpoint.

Attach a provider instance to a connection and the connection's models
appear on that instance alongside its own login models, badged with the
connection name. The instance picks automatically per thread: its own
models run on its own login, connection models run through the endpoint —
so a subscription model never leaves its own login. Custom models follow
the own login. Switching sides mid-thread is not possible; start a new
thread for a model on the other side. Not every harness can be pointed at an
endpoint: one that resolves models against its own vendor keeps a single
backend per instance and shows no connection models in the picker, so a
missing entry there is a harness limitation rather than a setup mistake.
Removing a connection returns its instances to their own login.

## Which instance serves a model

Which models an instance can serve is visible where models are picked:
the model picker groups by model first, with the serving provider
instances underneath — on both web and mobile.
