#!/bin/bash
# One-command network update — run from the project folder whenever you want fresh data:
#
#   npm run update              # pull from the AP-TRANSCO GIS → rebuild → test → commit → push (site redeploys)
#   npm run update -- --no-push # same, but stop before pushing (inspect locally first)
#
# Must run on a connection in India: the AP-TRANSCO GIS (gis.aptransco.gov.in) drops foreign traffic.
set -euo pipefail
cd "$(dirname "$0")/.."

PUSH=true
[ "${1:-}" = "--no-push" ] && PUSH=false

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "You're on branch '$branch'. Switch first:  git checkout main"; exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "You have uncommitted changes — commit or stash them first:"; git status --short; exit 1
fi

say "1/5  Getting the latest project from GitHub"
git pull --ff-only --quiet origin main
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund --silent
fi

say "2/5  Pulling the network from the AP-TRANSCO GIS"
set +e
npm run -s sync:live
rc=$?
set -e
if [ $rc -eq 3 ]; then echo "Can't reach gis.aptransco.gov.in — it only accepts connections from India (check VPN / network)."; exit 3; fi
if [ $rc -ne 0 ]; then echo "Sync failed (exit $rc) — nothing was changed."; exit $rc; fi
# Towers (~114k points, grouped by line). Non-fatal: a failed/rejected tower pull keeps the previous files.
npm run -s sync:towers || echo "Tower sync failed — keeping the previous tower data."

changed=false
[ -n "$(git status --porcelain -- data/raw/live ':!data/raw/live/manifest.json' ':!data/raw/live/towers-manifest.json')" ] && changed=true

say "3/5  Rebuilding the map data"
npm run -s build:data > /dev/null

say "4/5  Running checks"
npx vitest run scripts src > /dev/null || { echo "Checks FAILED — not publishing. Run 'npx vitest run scripts src' to see why."; exit 1; }
echo "All checks passed."

if [ "$changed" = true ]; then
  summary="$(node -e '
    const log = require("./data/raw/live/changelog.json"), m = require("./data/raw/live/manifest.json");
    const e = log[0] && log[0].at === m.lastRun ? log[0] : null;
    console.log(e ? e.layers.map(l => `${l.label}: +${l.added} / -${l.removed} / ~${l.modified}`).join("; ") : "layer refresh");
  ')"
  msg="data(live): network update — $summary"
else
  summary="no network changes since the last update"
  msg="data(live): network checked — no changes"
fi

say "5/5  Publishing"
git add data/raw/live public/data
git commit --quiet -m "$msg"
if [ "$PUSH" = true ]; then
  git push --quiet origin main
  echo "Pushed. The site redeploys in ~2 minutes: https://gsuryaias.github.io/ap-gis-grid/"
else
  echo "Committed locally (not pushed). Publish later with:  git push origin main"
fi
echo "Result: $summary"
