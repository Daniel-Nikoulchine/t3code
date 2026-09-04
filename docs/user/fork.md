# T3 Code Hermes fork

This repository is a fork of [T3 Code](https://github.com/pingdotgg/t3code),
on the `feat/hermes-driver` branch. It tracks upstream closely and adds one
thing: Hermes Agent as a built-in provider.

## What differs from upstream

Hermes shows up as a normal provider with model discovery, reasoning control,
approvals, and session resume. See [Hermes Agent](./providers-hermes.md).
Everything else behaves like upstream.

## Run it

The fork publishes no releases and no npm package, so run it from source. You
need Node.js (see [Install](./install.md) for the version) and pnpm.

```bash
git clone https://github.com/Daniel-Nikoulchine/t3code.git
cd t3code
git checkout feat/hermes-driver
pnpm install
pnpm dev:desktop
```

The desktop app starts its own backend. Provider CLIs (`hermes`, `codex`,
`claude`, and the rest) must be installed and logged in on the machine that
runs the server, same as upstream.

## What still comes from upstream

The npm `t3` package, the mobile apps, the hosted web app at `app.t3.codes`,
and the winget, Homebrew, and AUR artifacts are upstream builds without the
Hermes driver. If a fork server talks to an upstream client, expect the
version skew warning described in [Keeping T3 Code in sync](./updating.md).
Use the fork on both ends.

## Staying current

Upstream is merged in regularly with `scripts/sync-upstream.sh`, which also
re-runs the Hermes checks. Fork-only changes live in new files plus small
Hermes additions to existing docs, so those merges stay clean.
