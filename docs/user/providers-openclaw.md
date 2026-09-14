# OpenClaw

OpenClaw support is available as an Early Access provider. T3 Code talks to the official
`openclaw acp` bridge, which forwards agent sessions to a running
[OpenClaw Gateway](https://docs.openclaw.ai). Models, credentials, tools, and skills stay
configured in OpenClaw; T3 Code only needs to reach the gateway.

## Set up OpenClaw

Install the CLI and start a gateway on the machine running the T3 Code server:

```sh
npm install -g openclaw
openclaw onboard
openclaw gateway run
```

Then enable the OpenClaw card in T3 Code under **Settings** > **Providers**. The card reports
the detected CLI version. If the gateway is not reachable, the card shows a warning telling
you to start it — the CLI install itself is fine.

OpenClaw 2026.1.0 or newer is required for the supported ACP bridge behavior. Updates run
through the normal provider update action (`openclaw update --yes`).

## Gateway connection settings

Each OpenClaw instance can override how the bridge dials the gateway:

- **Gateway URL** — WebSocket URL of the gateway (for example `ws://127.0.0.1:18789`).
  Leave empty to use the `gateway.remote.url` from the OpenClaw config.
- **Gateway token** — shared token when the gateway requires auth. Stored in plain text on
  the T3 Code environment, like other provider secrets.
- **Session key** — default OpenClaw session key for the bridge (for example
  `agent:main:main`). Leave empty for the gateway default.

Run these on the machine running the T3 Code server, not on the device you browse from.

## Models

The bridge does not advertise a model catalog, so T3 Code offers a single `default` entry:
whatever model the gateway session is configured with. Custom entries accept any model id
your gateway understands. There is no reasoning-effort picker for OpenClaw.

## Multiple OpenClaw instances

OpenClaw supports multiple provider instances. Point instances at different gateways (or
different session keys on the same gateway) to keep their sessions isolated.

## Permissions and active turns

T3 Code maps permission modes as follows:

| T3 Code mode      | OpenClaw mode  |
| ----------------- | -------------- |
| Approval required | `default`      |
| Auto              | `default`      |
| Auto-accept edits | `accept_edits` |
| Full access       | `dont_ask`     |

Mode selection is best-effort: the bridge documents only partial support, so a rejected mode
keeps the bridge default instead of failing the session.

Approval buttons use the choices returned by OpenClaw. Plain-text messages sent while OpenClaw
is working redirect the active turn. Images are sent through ACP image support. Slash commands
advertised by the bridge appear in the composer, and `openclaw skills list` feeds the skill
picker. T3 Code persists the bridge session ID for continuation.

## Known limitations

- The bridge rejects per-session MCP servers, so T3 Code's `t3-code` tool bridge
  (`preview_*` tools) is not attached to OpenClaw sessions. The in-app preview browser panel
  itself is unaffected — only agent-driven `preview_*` calls are unavailable with this
  provider.
- There is no Plan interaction toggle or structured question form for OpenClaw.
