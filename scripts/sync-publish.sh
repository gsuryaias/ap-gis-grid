#!/bin/bash
# Live-sync publisher — run from a machine IN INDIA (the AP-TRANSCO GIS firewall drops foreign
# traffic, so GitHub-hosted runners cannot reach it). Installed as a macOS LaunchAgent by
# scripts/install-sync-agent.sh; safe to run by hand any time:  bash scripts/sync-publish.sh
#
# Works in a DEDICATED clone (default ~/.ap-gis-grid-sync) so it never touches your working copy.
#   1. hard-reset the clone to origin/main
#   2. npm run sync:live            (pull + diff every layer; gates reject bad pulls)
#   3. publish when the network changed, OR as a daily heartbeat (keeps the in-app "Live" badge
#      truthful): build:data → tests → commit → push. The push triggers deploy.yml → Pages.
set -euo pipefail

REPO_URL="${AP_GIS_GRID_REPO:-https://github.com/gsuryaias/ap-gis-grid.git}"
WORK="${AP_GIS_GRID_SYNC_DIR:-$HOME/.ap-gis-grid-sync}"
HEARTBEAT_HOURS="${AP_GIS_GRID_HEARTBEAT_HOURS:-20}"

# launchd runs with a bare PATH — find node (nvm / Homebrew) and git.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/bin | sort -V | tail -1)"
  export PATH="$NODE_DIR:$PATH"
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# One run at a time.
LOCK="${TMPDIR:-/tmp}/ap-gis-grid-sync.lock"
if ! mkdir "$LOCK" 2>/dev/null; then log "another sync is running — exiting"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

if [ ! -d "$WORK/.git" ]; then
  log "cloning $REPO_URL → $WORK"
  git clone --quiet "$REPO_URL" "$WORK"
fi
cd "$WORK"
git fetch --quiet origin main
git checkout --quiet -B main origin/main
git reset --quiet --hard origin/main
git clean -fdq -- data/raw/live public/data

LOCK_HASH="$(shasum package-lock.json | cut -c1-40)"
if [ ! -d node_modules ] || [ "$(cat node_modules/.lock-hash 2>/dev/null)" != "$LOCK_HASH" ]; then
  log "installing dependencies"
  npm ci --no-audit --no-fund --silent
  echo "$LOCK_HASH" > node_modules/.lock-hash
fi

prev_success="$(node -e 'try{console.log(require("./data/raw/live/manifest.json").lastSuccess||"")}catch{console.log("")}')"

log "syncing from the AP-TRANSCO GIS"
set +e
npm run -s sync:live
rc=$?
set -e
if [ $rc -ne 0 ]; then log "sync failed (exit $rc) — nothing published"; exit $rc; fi

changed=false
[ -n "$(git status --porcelain -- data/raw/live ':!data/raw/live/manifest.json')" ] && changed=true

heartbeat=false
if [ "$changed" = false ]; then
  age_h="$(node -e 'const p=process.argv[1]; console.log(p ? Math.floor((Date.now()-Date.parse(p))/3.6e6) : 9999)' "$prev_success")"
  [ "$age_h" -ge "$HEARTBEAT_HOURS" ] && heartbeat=true
  log "no network change (last published sync ${age_h} h ago)"
fi

if [ "$changed" = false ] && [ "$heartbeat" = false ]; then
  log "nothing to publish"
  exit 0
fi

log "rebuilding static data"
npm run -s build:data > /dev/null
npx vitest run scripts src > /dev/null || { log "tests FAILED — not publishing"; exit 1; }

if [ "$changed" = true ]; then
  summary="$(node -e '
    const log = require("./data/raw/live/changelog.json"), m = require("./data/raw/live/manifest.json");
    const e = log[0] && log[0].at === m.lastRun ? log[0] : null;
    console.log(e ? e.layers.map(l => `${l.name} +${l.added}/-${l.removed}/~${l.modified}`).join(", ") : "layer refresh");
  ')"
  msg="data(live): network sync — $summary"
else
  msg="data(live): daily sync heartbeat — no network changes"
fi

git add data/raw/live public/data
if git diff --cached --quiet; then log "nothing staged"; exit 0; fi
git -c user.name="ap-gis-grid sync" -c user.email="ap-gis-grid-sync@users.noreply.github.com" commit --quiet -m "$msg"
git push --quiet origin HEAD:main
log "published: $msg"
