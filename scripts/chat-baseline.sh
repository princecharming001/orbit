#!/usr/bin/env bash
# One pass of the chat quality bench (docs/plan/28-chat-quality-campaign.md): every simulated-student scenario against
# the real engine and Claude, judged, with the shape of each reply checked, then the summary. Needs ANTHROPIC_API_KEY
# in the shell; it is passed to the test process and never written anywhere.
#
#   ANTHROPIC_API_KEY=... scripts/chat-baseline.sh [group=all] [out=docs/qa/chat-runs/<date>-<group>]
#
# SIM_STRICT=1 enforces the plan 28 bar instead of recording it; SIM_ONLY=id1,id2 runs a few scenarios.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ORBIT_SIM_PROXY:-}" ]; then
  echo "ANTHROPIC_API_KEY is not set (export it in this shell first; it is never stored)." >&2
  exit 2
fi

group="${1:-all}"
out="${2:-docs/qa/chat-runs/$(date +%Y-%m-%d)-$group}"
mkdir -p "$out"
echo "running sim group '$group' into $out"

set +e
NODE_USE_ENV_PROXY=1 SIM_GROUP="$group" SIM_DIR="$PWD/$out" \
  pnpm --filter @orbit/web exec vitest run src/chat/__tests__/sim/run --no-file-parallelism --reporter=dot \
  2>&1 | tee "$out/_run.log" | tail -40
status=${PIPESTATUS[0]}
set -e

if [ -f "$out/_scorecard.json" ]; then
  node scripts/chat-eval.mjs "$out/_scorecard.json" | tee "$out/_summary.txt"
else
  echo "no scorecard written (see $out/_run.log)" >&2
fi
echo "vitest exit $status (failures are findings in a baseline run, not a broken bench)"
