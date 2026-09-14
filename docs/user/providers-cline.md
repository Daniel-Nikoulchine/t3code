# Cline

Cline support is available as an Early Access provider. T3 Code connects to the official Cline
CLI over the Agent Client Protocol (`cline --acp`) and uses Cline's existing models,
credentials, tools, skills, and session history.

## Set up Cline

Install the Cline CLI and authenticate:

```sh
npm i -g cline
cline auth
```

Restart or refresh T3 Code's provider status after setup. The Cline card reports the detected CLI
version and offers the normal provider update action, which runs `cline update`.

## Models and modes

Cline reports its configured models directly to T3 Code. The `default` entry keeps the model
selected in Cline. Free models from the Cline API are always added to the picker as well; entries
the CLI already reports keep their place, so nothing appears twice. The composer's Plan toggle maps onto Cline's own plan/act session modes, so
plan-mode turns explore without modifying files.

## Permissions and active turns

Every file edit and command goes through T3 Code's permission UI unless the thread runs in Full
access, which starts Cline with auto-approval enabled. Automatic approval prefers the
session-scoped choice and never silently creates a permanent grant.

Cline skills discovered below `.cline/skills` (project-local) and `~/.cline/skills` (user-global)
appear in the `$` picker; typing `$name` in the composer resolves to Cline's native `/name` form.
Source-control text generation (commit messages, PR content, branch and thread titles) runs in
Cline's read-only plan mode so it never edits files as a side effect.

T3 Code persists Cline's ACP session ID for continuation. On resume, Cline restores its own
history while T3 Code suppresses that replay because the conversation is already stored in the
thread.
