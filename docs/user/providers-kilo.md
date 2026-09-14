# Kilo Code

Kilo Code support is available as an Early Access provider. T3 Code connects to the official Kilo
Agent Client Protocol server and uses Kilo's existing models, credentials, tools, skills, and
session history.

## Set up Kilo

Install the Kilo CLI:

```sh
npm install -g @kilocode/cli
```

Then sign in and verify the setup:

```sh
kilo auth login
kilo models
```

Restart or refresh T3 Code's provider status after setup. The Kilo card reports the detected CLI
version and offers the normal provider update action, which runs `kilo upgrade`.

## Models

T3 Code lists the models reported by `kilo models` (entries look like `provider/model`, for
example `anthropic/claude-sonnet-4-20250514`). Custom entries must use that exact
`provider/model` identifier. The `auto` entry keeps whatever model the Kilo session is running
on instead of switching.

Signing in with `kilo auth login` covers Kilo Gateway models. Direct provider keys also work:
set the matching environment variable on the Kilo instance (for example `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY`) and T3 Code treats the instance as authenticated.

## Permissions and active turns

Kilo has no separate approval-mode switch: every tool permission arrives as an approval prompt
in T3 Code. Approval buttons use the choices returned by Kilo, preferring the session-scoped
choice, and Full access mode approves them automatically.

Plain-text messages sent while Kilo is working redirect the active turn. Images are sent through
Kilo's ACP image support. Kilo slash commands advertised by the running CLI appear in the
composer. Interactive sessions load both Kilo's configured MCP servers and T3 Code's bridge.

## Skills

Mention a skill with `$name` in the composer and T3 Code rewrites it to Kilo's native `/name`
form when the skill exists. Skills are discovered from the project's `.kilo/skills` and
`.agents/skills` directories plus the user-global `~/.config/kilo/skills` directory.

T3 Code persists Kilo's ACP session ID for continuation. On resume, Kilo restores its own
history while T3 Code suppresses that replay because the conversation is already stored in the
thread.
