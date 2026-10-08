#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v node >/dev/null 2>&1 || {
  echo 'Install Node >=22, then retry scripts/bootstrap.sh.' >&2
  exit 1
}
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo 'Node >=22 is required.' >&2
  exit 1
}
command -v corepack >/dev/null 2>&1 || {
  echo 'Install Corepack for the pinned pnpm, then retry scripts/bootstrap.sh.' >&2
  exit 1
}
# package.json scripts and scripts/local.ts call `pnpm` directly; corepack alone does not put it on PATH.
command -v pnpm >/dev/null 2>&1 || corepack enable pnpm || {
  echo 'pnpm is not on PATH. Run `corepack enable pnpm` (or install pnpm), then retry.' >&2
  exit 1
}
hooks=$(git config --get core.hooksPath || true)
if [ -n "$hooks" ] && [ "$hooks" != .githooks ]; then
  echo "Existing core.hooksPath=$hooks; integrate .githooks before retrying." >&2
  exit 1
fi
# ponytail: pnpm reuses its download store; each checkout owns its node_modules.
corepack pnpm install --frozen-lockfile
git config --local core.hooksPath .githooks
corepack pnpm local:info
printf '\nReady. Start the web app: corepack pnpm dev\n'
printf 'Optional local database (Docker required): corepack pnpm db:start\n'
