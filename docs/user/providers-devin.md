# Devin

Devin support is available as an Early Access provider. T3 Code connects to the official Devin
CLI over the Agent Client Protocol (`devin acp`) and uses Devin's existing models, credentials,
tools, skills, and session history.

## Set up Devin

Install the Devin CLI:

```sh
curl -fsSL https://cli.devin.ai/install.sh | bash
```

Then sign in:

```sh
devin auth login
```

Restart or refresh T3 Code's provider status after setup. The Devin card reports the detected CLI
version and offers the normal provider update action, which runs `devin update`. Alternatively,
authenticate with a `WINDSURF_API_KEY` environment variable on the Devin provider instance.

Enable Devin in T3 Code under **Settings > Providers**. Like Cursor and Grok, Devin is opt-in while the
binding is young.

## Multiple Devin instances

The built-in instance uses Devin's normal configuration directory. Additional provider instances
can set a different binary path or supply environment overrides per instance. Instances that share
the same Devin configuration can continue each other's sessions; different homes keep
configuration, credentials, and history isolated.

Devin reports its configured models directly to T3 Code. Custom entries must use the exact model
identifier Devin expects, such as `opus`, `sonnet`, or `swe`. The `devin-default` entry keeps the
model currently selected in Devin.

## Permissions and active turns

T3 Code maps permission modes as follows:

| T3 Code mode      | Devin mode     |
| ----------------- | -------------- |
| Approval required | `normal`       |
| Auto              | `smart`        |
| Auto-accept edits | `accept-edits` |
| Full access       | `dangerous`    |

Approval buttons use the choices returned by Devin. Automatic approval prefers the session-scoped
choice and never silently creates a permanent grant.

Plain-text messages sent while Devin is working redirect the active turn. Images are sent through
Devin's ACP image support. Devin slash commands advertised by the running CLI appear in the
composer. Type `$skill-name` in the composer to invoke a Devin skill; T3 Code rewrites it to
Devin's native `/skill-name` form. Interactive sessions load both Devin's configured MCP servers
and T3 Code's bridge; short-lived provider checks and source-control text generation skip
configured MCP startup.

T3 Code persists Devin's ACP session ID for continuation. On resume, Devin restores its own
history while T3 Code suppresses that replay because the conversation is already stored in the
thread.
