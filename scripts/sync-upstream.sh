#!/usr/bin/env bash
# sync-upstream.sh — merge upstream/main into feat/hermes-driver, keep it green.
#
# This is the heartbeat of "always current": every T3 release pulls upstream
# main into our Hermes-driver branch and verifies the Hermes ACP provider
# still compiles and its tests still pass. Run it periodically (weekly) or
# after any notable upstream release.
#
# Usage:
#   scripts/sync-upstream.sh          # fetch + merge + typecheck + hermetic tests
#   scripts/sync-upstream.sh --no-test  # merge only, skip the verification
#
# Never run this from a dirty worktree: uncommitted changes block the merge.
# A merge conflict means the upstream moved a file our Hermes delta touches;
# resolve it by keeping BOTH the upstream intent and our `hermes` wiring, then
# re-run. If the conflict is purely upstream-vs-upstream, `git checkout --theirs`
# and re-apply our small delta.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Clean worktree check"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: dirty worktree. Commit or stash before syncing." >&2
  exit 1
fi

echo "==> Fetch upstream"
git fetch upstream
git fetch origin

echo "==> Current branch: $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
echo "==> Upstream main:  $(git rev-parse --short upstream/main)"

echo "==> Merge upstream/main"
if git merge-base --is-ancestor upstream/main HEAD; then
  echo "Already up to date. Nothing to merge."
else
  git merge upstream/main --no-edit
fi

if [[ "${1:-}" == "--no-test" ]]; then
  echo "==> Skipping verification (--no-test)."
  echo "Merge complete. Commit the result when you are ready to push."
  exit 0
fi

echo "==> Typecheck (packages/contracts + server)"
export PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH" 2>/dev/null || true
command -v node >/dev/null || { echo "node not on PATH."; exit 1; }
pnpm --filter @t3tools/contracts typecheck
pnpm --filter t3 typecheck

echo "==> Hermes-focused tests"
pnpm --filter @t3tools/contracts test
pnpm --filter t3 exec vp test run \
  "src/provider/acp/HermesAcpSupport.test.ts" \
  "src/provider/Layers/HermesAdapter.test.ts" \
  "src/provider/Layers/HermesProvider.test.ts" \
  "src/provider/Drivers/HermesHome.test.ts" \
  "src/provider/Layers/ProviderInstanceRegistryLive.test.ts" \
  "src/provider/Layers/ProviderRegistry.test.ts"

echo "==> FULL server test suite"
pnpm --filter t3 test

echo "==> Sync complete. Hermes provider is green on $(git rev-parse --short upstream/main)."
echo "Commit the merge to keep the branch record clean before pushing."
