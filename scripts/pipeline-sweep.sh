#!/usr/bin/env zsh
# Unattended scan-and-evaluate sweep, run via launchd/cron (see docs/AUTOMATION.md).
# scan.mjs is read-only (public job-board APIs, zero tokens); the claude -p
# pass below evaluates each new posting and generates a report + PDF per the
# existing auto_pdf_score_threshold gate, but NEVER fills out or submits a
# real application form. That is a hard, non-negotiable design guarantee of
# this whole project -- see AGENTS.md's Ethical Use section and the
# Human-in-the-Loop row in README.md's feature table: "The system never
# submits an application -- you always have the final call." This sweep
# produces the report + tailored CV for you to review; you (or a live
# session) decide per posting whether to actually apply, exactly like every
# manual /career-ops pipeline run today.

set -euo pipefail

# launchd/cron spawn with a minimal PATH that typically omits Homebrew,
# ~/.local/bin (where the `claude` launcher symlink lives), and an
# fnm-managed `node` (only put on PATH by fnm's shell-init hook, which a
# non-interactive `zsh -l` login shell does not source).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -t "$HOME"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | head -1)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "Error: no node binary found on PATH or under ~/.fnm/node-versions" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${0}")/.." && pwd)"
OUT_DIR="$REPO/output"
DATE_STR="$(date +%Y-%m-%d)"
DIGEST_FILE="$OUT_DIR/pipeline-sweep-$DATE_STR.md"
LOG_FILE="$REPO/data/pipeline-sweep.log"

mkdir -p "$OUT_DIR"
cd "$REPO"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') scan starting ==="
  "$NODE_BIN" scan.mjs --json
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') scan.mjs done ==="
} >> "$LOG_FILE" 2>&1

# If scan.mjs found nothing new, don't burn a Claude session evaluating an
# empty Pending list.
PENDING_COUNT=$(awk '/^## Pending$/{p=1;next}/^## /{p=0}p && /^- \[ \]/{c++}END{print c+0}' data/pipeline.md 2>/dev/null || echo 0)
if [ "$PENDING_COUNT" -eq 0 ]; then
  {
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') no new postings in data/pipeline.md Pending -- skipping evaluation ==="
  } >> "$LOG_FILE" 2>&1
  exit 0
fi

PROMPT="Run the career-ops '/career-ops pipeline' mode (modes/pipeline.md) against every entry currently in data/pipeline.md's ## Pending section. Evaluate each against config/profile.yml per the mode's normal A-H evaluation, write a report to reports/, and generate a tailored CV/PDF per the mode's own auto_pdf_score_threshold gate (skip PDF generation below threshold, as documented). Update data/applications.md via the tracker's normal write path and move each processed entry from data/pipeline.md's Pending section to Processed, exactly as an interactive run would. STOP THERE. Do not open a browser, do not navigate to any application portal, do not fill out or submit any application form, and do not click Apply/Submit/Send anywhere -- this is an unattended run and submitting a real application without a human reviewing it first is this project's absolute, non-negotiable guarantee (see AGENTS.md). After processing every Pending entry, write a short digest to $DIGEST_FILE: for each posting, its company/role/score/report link/PDF status, sorted highest score first. If data/pipeline.md's Pending section is empty, write a one-line note saying so instead."

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') pipeline evaluation starting ($PENDING_COUNT pending) ==="
  claude -p "$PROMPT"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') pipeline evaluation done -> $DIGEST_FILE ==="
} >> "$LOG_FILE" 2>&1

if [ -f "$DIGEST_FILE" ]; then
  osascript -e "display notification \"Pipeline sweep ready: $DIGEST_FILE\" with title \"career-ops\"" >/dev/null 2>&1 || true
fi
