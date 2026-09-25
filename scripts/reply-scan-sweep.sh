#!/usr/bin/env zsh
# Unattended reply-check sweep, run via launchd/cron (see docs/AUTOMATION.md).
# gmail-reply-scan.mjs is read-only (Gmail search only, never touches
# data/applications.md); the claude -p pass below only drafts to output/ and
# never sends, submits, or updates the tracker on its own.
#
# Requires the `gws` (Google Workspace CLI) binary authenticated locally —
# this is a personal convenience path, not career-ops's plugin architecture
# (issue #1583 tracks a proper OAuth-env plugin build of this same idea).

set -euo pipefail

REPO="$(cd "$(dirname "${0}")/.." && pwd)"
OUT_DIR="$REPO/output"
DATE_STR="$(date +%Y-%m-%d)"
DRAFT_FILE="$OUT_DIR/reply-review-$DATE_STR.md"
LOG_FILE="$REPO/data/reply-scan-sweep.log"

mkdir -p "$OUT_DIR"
cd "$REPO"

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') reply scan starting ==="
  node gmail-reply-scan.mjs
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') gmail-reply-scan.mjs done ==="
} >> "$LOG_FILE" 2>&1

PROMPT="Run the career-ops 'reply-watch' mode (modes/reply-watch.md) in REPORT-ONLY mode. Read data/reply-candidates.json, data/applications.md, and data/follow-ups.md, and reproduce reply-watch.mjs's own matching/classification (reply-matcher.mjs's matchCandidates()/classifyReply()) for every candidate. Do NOT run 'node reply-watch.mjs' itself -- it prompts interactively (y/N) and this call is unattended. For every candidate classified Interview, Offer, Rejected, Need Action, or Responded, draft the appropriate reply email (voice-dna.md guardrails apply): an interview-scheduling reply for Interview, a brief gracious acknowledgment for Rejected, an assessment-completion/scheduling reply for Need Action. Write the full digest (every candidate, its type, evidence, matched application) plus every drafted response to $DRAFT_FILE as markdown. Do NOT edit data/applications.md, data/reply-candidates.json, or data/reply-scan-state.json -- draft-only; the user reviews and applies real tracker updates themselves via 'node reply-watch.mjs'. Do NOT send, submit, archive, or label anything. If data/reply-candidates.json has no candidates, write a one-line note saying so instead of a digest."

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') reply digest+draft starting ==="
  claude -p "$PROMPT"
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') reply digest+draft done -> $DRAFT_FILE ==="
} >> "$LOG_FILE" 2>&1

if [ -f "$DRAFT_FILE" ]; then
  osascript -e "display notification \"Reply review ready: $DRAFT_FILE\" with title \"career-ops\"" >/dev/null 2>&1 || true
fi
