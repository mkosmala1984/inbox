#!/bin/sh
# Runs the inbox model's eval cases in evals/cases.json on Sonnet, and exits 1 when a case passes in fewer runs
# than its bar. Each run calls a model, so check.sh leaves this out. Run it after a
# change to systemText or buildPrompt, and when a model alias moves.
#
# Needs npx and the claude CLI.
#
# Usage: ./scripts/eval.sh [--runs N] [--case name,name] [--out answers.json]

set -eu

DIR=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)
bundle=$(mktemp -d)
trap 'rm -rf "$bundle"' EXIT
npx -y esbuild@0.28.2 "$DIR/evals/run.ts" --bundle --platform=node --format=esm \
    --outfile="$bundle/run.mjs" --log-level=warning
node "$bundle/run.mjs" --cases "$DIR/evals/cases.json" "$@"
