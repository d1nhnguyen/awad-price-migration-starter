#!/usr/bin/env bash
# IA#2 from start to finish, under traffic — the sequence of MIGRATION.md, step by step.
# One run writes traffic-log.txt (ONE continuous `npm run traffic`, v1 to after the
# last migration) and check-log.txt (`npm run check` after every step, labelled).
#
#   bash scripts/run-ia2.sh        from the repository root, Node 22.5+
#
# It starts from scratch: data/app.db, traffic-log.txt and check-log.txt are replaced.
# Each code version runs from its own git worktree, made from its tag (../ia2-v1 …
# ../ia2-v4), and every one of them opens the same database file. Every deploy is a
# rolling restart: one instance stops (finishing in-flight requests), the new version
# starts on that port, and only then is the other instance replaced.
#
#   PAUSE=5            seconds of traffic between steps
#   PORT_A=3001 PORT_B=3002
set -euo pipefail
set -m # background jobs keep SIGINT, so the traffic script can stop cleanly and print its RESULT

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
export DB_PATH="$ROOT/data/app.db"
PAUSE=${PAUSE:-5}
PORT_A=${PORT_A:-3001}
PORT_B=${PORT_B:-3002}
export TARGETS="http://localhost:$PORT_A,http://localhost:$PORT_B"
WT="$(dirname "$ROOT")/ia2"
CHECK_LOG="$ROOT/check-log.txt"
TRAFFIC_LOG="$ROOT/traffic-log.txt"

node -e "require('node:sqlite')" 2>/dev/null || { echo "needs Node 22.5+ (node:sqlite) — try: nvm use 26"; exit 1; }
for p in $PORT_A $PORT_B; do
  if curl -s "localhost:$p/health" >/dev/null; then echo "something already listens on :$p — stop it first"; exit 1; fi
done

declare -A PID
TPID=
cleanup() {
  [ -n "$TPID" ] && kill -INT "$TPID" 2>/dev/null || true
  for p in "${PID[@]}"; do kill -TERM "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

say() { echo; echo "##### $*"; }
up() { # up <version> <port>
  (cd "$WT-$1" && PORT=$2 exec node src/server.js >>"$ROOT/data/server-$2.log" 2>&1) &
  PID[$2]=$!
  for _ in $(seq 200); do curl -sf "localhost:$2/health" >/dev/null && return; sleep 0.05; done
  echo "$1 did not start on :$2 — see data/server-$2.log"; exit 1
}
down() { kill -TERM "${PID[$1]}"; wait "${PID[$1]}" 2>/dev/null || true; }
restart() { echo "  :$1 → $2"; down "$1"; up "$2" "$1"; sleep "$PAUSE"; }
roll() { say "rolling restart to $1"; restart "$PORT_A" "$1"; restart "$PORT_B" "$1"; }
# `step <label>` — npm run check, labelled, with where traffic-log.txt stood at that moment
step() {
  {
    echo
    echo "=== step $1 · $(date '+%F %T') · traffic-log.txt line $(wc -l <"$TRAFFIC_LOG")"
    node scripts/check.js || true
  } >>"$CHECK_LOG"
  echo "  check [$1]: $(tail -1 "$CHECK_LOG")"
}
# `logged <label> <cmd…>` — a migration or the backfill, its output kept in check-log.txt too
logged() {
  local label=$1; shift
  echo >>"$CHECK_LOG"; echo "--- $label: $*" >>"$CHECK_LOG"
  "$@" 2>&1 | tee -a "$CHECK_LOG" | sed 's/^/  /'
}

say "fresh database, one worktree per tag"
mkdir -p data
rm -f data/app.db data/app.db-* data/server-*.log data/down-demo.db* "$TRAFFIC_LOG" "$CHECK_LOG"
git worktree prune
for v in v1 v2 v3 v4; do
  [ -d "$WT-$v" ] && git worktree remove --force "$WT-$v"
  git worktree add --detach -q "$WT-$v" "$v"
  echo "  $WT-$v at $v ($(git rev-parse --short "$v"))"
done
echo "IA#2 run · $(date '+%F %T') · db $DB_PATH · $(node -v) · HEAD $(git rev-parse --short HEAD)" >"$CHECK_LOG"
(cd "$WT-v1" && node scripts/migrate.js up && node scripts/seed.js)

say "step 0 · v1 on both instances, traffic starts (old clients only)"
up v1 "$PORT_A"; up v1 "$PORT_B"
node scripts/traffic.js >data/traffic.out 2>&1 &
TPID=$!
until grep -q 'traffic start' "$TRAFFIC_LOG" 2>/dev/null; do sleep 0.1; done
sleep "$PAUSE"; step "0 · v1 on both instances (baseline)"

say "step 1 · expand: migration 002, while v1 serves"
logged "step 1 · migration 002" bash -c "cd '$WT-v2' && node scripts/migrate.js up"
sleep "$PAUSE"; step "1 · migration 002 applied, v1 on both instances"
logged "step 1 · backfill tried while v1 still serves (must refuse)" bash -c "cd '$WT-v2' && node scripts/backfill.js" || true

roll v2
step "2 · v2 on both instances (dual write)"
say "new clients on: every instance offers priceVnd"
kill -USR2 "$TPID"; sleep "$PAUSE"

say "step 3 · backfill — stopped halfway, then run again"
# Ctrl+C sent to the backfill alone (`timeout` would signal this script as well)
interrupted_backfill() {
  (cd "$WT-v2" && exec node scripts/backfill.js) &
  local p=$!
  sleep 0.5; kill -INT "$p" 2>/dev/null || true; wait "$p"
}
logged "step 3 · backfill, Ctrl+C after 0.5 s" interrupted_backfill
step "3a · backfill stopped halfway"
logged "step 3 · backfill, run again" bash -c "cd '$WT-v2' && node scripts/backfill.js"
step "3b · backfill finished"
sleep "$PAUSE"

roll v3
step "4 · v3 on both instances (reads price_vnd)"
roll v2
step "4r · ROLLBACK under traffic: v2 on both instances again"
roll v3
step "4f · forward again: v3 on both instances"

roll v4
step "5 · v4 on both instances (price neither read nor written)"

say "step 6 · contract: migration 003 drops price — the point of no return"
logged "step 6 · migration 003" node scripts/migrate.js up
sleep "$PAUSE"; step "6 · migration 003 applied (price dropped), v4 on both instances"
sleep "$PAUSE"

say "traffic stops"
kill -INT "$TPID"
wait "$TPID" && TRAFFIC_OK=1 || TRAFFIC_OK=0
TPID=
down "$PORT_A"; down "$PORT_B"; PID=()
tail -2 "$TRAFFIC_LOG" | sed 's/^/  /'
step "end · after the traffic run"

say "migrate:down for every migration, on a copy of the database — then up again, step by step"
cp data/app.db data/down-demo.db
{ echo; echo "=== migrate:down for every migration, on a copy (data/down-demo.db) — the live database is not touched"; } >>"$CHECK_LOG"
demo() { # demo <dir> <cmd…> — run in <dir> against the copy, then check it
  logged "$(basename "$1"): ${*:2}" env DB_PATH="$ROOT/data/down-demo.db" bash -c "cd '$1' && ${*:2}"
  echo "· check:" >>"$CHECK_LOG"
  DB_PATH="$ROOT/data/down-demo.db" node scripts/check.js >>"$CHECK_LOG" || true
  echo "  check: $(tail -1 "$CHECK_LOG")"
}
demo "$ROOT" node scripts/migrate.js down        # reverts 003: price re-derived from price_vnd
demo "$ROOT" node scripts/migrate.js down        # reverts 002: price_vnd dropped, back to the v1 schema
# and up again the way the plan goes: 002 alone (from v2), backfill, then 003
demo "$WT-v2" node scripts/migrate.js up
demo "$WT-v2" FORCE=1 node scripts/backfill.js   # no instance serves the copy
demo "$ROOT" node scripts/migrate.js up

say "done"
echo "  traffic-log.txt: $(tail -1 "$TRAFFIC_LOG")"
echo "  check-log.txt:   $(grep -c '^=== step' "$CHECK_LOG") labelled checks"
[ "$TRAFFIC_OK" = 1 ] || { echo "  the traffic run FAILED — read traffic-log.txt"; exit 1; }
