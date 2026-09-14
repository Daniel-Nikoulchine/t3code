# OpenCode

Install and authenticate OpenCode on the machine running your environment, then
enable it in **Settings > Providers**. See [provider setup](./install.md#providers).
T3 Code requires OpenCode 1.14.19 or newer, including when you connect an existing
OpenCode server.

## Local or external server

Leave **Server URL** empty to let T3 Code start OpenCode locally. A password in
provider settings applies to both that server and T3 Code's connection. With no
password setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its
environment.

To use an existing OpenCode server, set **Server URL** and its password in provider
settings. T3 Code uses only that configured password for an external server; it
does not forward a local `OPENCODE_SERVER_PASSWORD`. If connection or version checks
fail, check the URL, credentials, and OpenCode version, then refresh provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode
session.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before T3 Code can see configuration changes.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.

## External model providers

Any OpenCode or ACP-based instance can route its models through an external
OpenAI- or Anthropic-compatible endpoint instead of OpenCode's own login. In
**Settings > Providers**, tap the plus button, pick a **template** to prefill the
form (or start from **Custom**), then add the connection once: its base URL (for
example `https://proxy.example/v1` for an OmniRoute, LiteLLM, or Ollama endpoint,
API prefix included), the wire protocols it speaks, and its key — reference a
stored [API key](./providers.md#api-keys) or name the server-environment variable
holding it. With a variable, only the name is stored; the key value stays in the
server environment and never lands in settings, snapshots, or logs. The URL must
be reachable from the environment's machine, so the same setup works over remote
and tunnel connections with no localhost default. Use **Test** to check
reachability before adding; after the first successful routed turn, instances
also show when it last worked.

Then pick a connection on each provider instance under **Settings > Providers**
(Direct means its own login). Deleting a connection returns its instances to
Direct.

When a turn fails on a rate limit or provider error, a thread can automatically
continue on another model instead of stopping. Next to the model picker, switch the
thread from Single to Combo, add further targets, and pick a strategy: Priority
follows the listed order, Headroom prefers the target with the most remaining quota,
and Last known good sticks to the most recently working target. Clearing the combo
returns the thread to one fixed model. The combo editor sits next to the composer on
web and in thread settings on mobile.

Models reached through a backend carry a `via provider` badge; when their capabilities
differ from the native catalog, the badge notes `Capabilities degraded`. A turn that
moved to another target shows `Model rerouted` with the models involved. Routed turns
can differ in quality and tool support, and usage shows no cost estimate for them —
set custom model prices if you need figures there.
