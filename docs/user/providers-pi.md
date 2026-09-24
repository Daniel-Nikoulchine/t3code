# Pi

Pi support is available as an Early Access provider. T3 Code drives the Pi
coding agent through its RPC interface and uses Pi's existing providers,
models, credentials, tools, skills, and session history — unless the
instance runs on a shared API connection (see below).

## Shared API connection

A Pi instance can run on a shared API connection instead of its own
login: pick a connection under **Connection** on the Pi harness card.
T3 Code registers a `t3-backend` provider inside Pi and lists the
connection's models as `t3-backend/<model>`, so those need no `pi`
`/login`. Pi's own models keep using its own login, and removing the
connection returns the instance to it.

## Set up Pi

Install Pi with `npm i -g @mariozechner/pi-agent`, then log in to at least
one provider:

```sh
pi
# then run /login inside Pi and pick a provider
```

Restart or refresh T3 Code's provider status after setup. The Pi card reports
the detected CLI version and offers the normal provider update action, which
runs `pi update`.

## Multiple Pi instances

The built-in instance uses Pi's normal configuration directory. Additional
provider instances can set a different **PI_CODING_AGENT_DIR path** or supply
`PI_CODING_AGENT_DIR` in their environment. Instances that share a directory
can continue each other's sessions; different directories keep
configuration, credentials, and history isolated.

Pi reports its configured models directly to T3 Code. Model slugs use the
form `provider/model` (for example `openai/gpt-5-nano`), matching Pi's own
model syntax. The `default` entry keeps the model selected in Pi.

## Reasoning effort

Models that support it show a **Reasoning** control beside the model picker,
with levels from Off to Extra High and Low as the default. The choice is
applied to the live session and re-applied after model switches.

## Permissions and active turns

Pi tools run without an approval gate; there is nothing to approve in T3
Code. When a Pi extension asks a question (a picker, confirmation, or text
prompt), it appears as a T3 Code user-input request and the answer is sent
back to Pi.

Plain-text messages sent while Pi is working steer the active turn. Images
are sent through Pi's RPC image support. Pi commands advertised by the
running agent appear in the composer, and Pi skills from the user and project
skill directories appear in the skills picker (`/skill:name`).

T3 Code persists Pi's session file for continuation. On resume, Pi restores
its own history while T3 Code suppresses that replay because the
conversation is already stored in the thread.
