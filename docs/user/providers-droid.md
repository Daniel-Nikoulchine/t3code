# Factory Droid

Droid support is available as an Early Access provider. T3 Code connects to the official
Factory Droid CLI over the Agent Client Protocol (`droid exec --output-format acp`) and uses
Droid's existing models, credentials, tools, skills, and session history.

## Set up Droid

Install the Droid CLI, then authenticate with your Factory account:

```sh
curl -fsSL https://app.factory.ai/cli | sh
droid
```

(Alternative: `npm install -g droid`.) The first interactive launch walks through sign-in; headless
environments can set `FACTORY_API_KEY` instead. Restart or refresh T3 Code's provider status after
setup. The Droid card reports the detected CLI version, the login state (read from
`droid doctor --auth`, no browser involved), and offers the normal provider update
action, which runs `droid update`. While logged out the card points back here instead of letting
sessions hang in authentication.

## Models

Droid reports its available models directly to T3 Code over ACP. The `auto` entry keeps the model
selected in Droid. Custom entries must use the exact model identifier Droid advertises.

## Permissions and active turns

`droid exec` is read-only by default; T3 Code maps permission modes onto Droid autonomy levels:

| T3 Code mode      | Droid flags                  |
| ----------------- | ---------------------------- |
| Approval required | _(none — spec-mode default)_ |
| Auto              | `--auto medium`              |
| Auto-accept edits | `--auto low`                 |
| Full access       | `--skip-permissions-unsafe`  |

Approval buttons use the choices returned by Droid. Automatic approval prefers the session-scoped
choice and never silently creates a permanent grant. Only use Full access in isolated
environments — it bypasses all Droid permission checks.

Plain-text messages sent while Droid is working redirect the active turn. Images are sent through
ACP image support. Droid skills from `.factory/skills/` (project), `~/.factory/skills/`
(personal), and the `.agents/skills` compatibility folders appear in the composer's `$` picker;
mentioning one as `$name` sends Droid its native `/name` form. Interactive sessions load T3
Code's MCP bridge alongside the thread environment.

T3 Code persists Droid's ACP session ID for continuation. On resume, Droid restores its own
history while T3 Code suppresses that replay because the conversation is already stored in the
thread.
