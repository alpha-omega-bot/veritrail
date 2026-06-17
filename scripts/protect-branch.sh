#!/usr/bin/env bash
#
# Configure long-term safety guards on the Veritrail GitHub repo via the API.
#
# Idempotent: re-running re-applies the same protection. Requires `gh` auth with
# admin on the target repo.
#
# Usage:
#   scripts/protect-branch.sh <owner/repo> [branch]
#
# Guards applied to the protected branch:
#   - Required status checks (must pass before merge), strict (branch up to date)
#   - Required pull-request review (>=1 approval, stale approvals dismissed)
#   - Enforced for admins (no bypass)
#   - Force-push and deletion blocked
#   - Conversation resolution required
#   - Linear history required

set -euo pipefail

REPO="${1:-}"
BRANCH="${2:-main}"

if [[ -z "$REPO" ]]; then
  echo "usage: scripts/protect-branch.sh <owner/repo> [branch]" >&2
  exit 2
fi

# The status-check contexts must match the job names GitHub reports from CI.
# CI defines: verify (node 20), verify (node 22), and the ledger-integrity gate.
read -r -d '' PAYLOAD <<'JSON' || true
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "verify (node 20)",
      "verify (node 22)",
      "ledger integrity gate"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
JSON

echo "▶ Applying branch protection to ${REPO}@${BRANCH}…"
echo "$PAYLOAD" | gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  --input - >/dev/null

echo "✓ Branch protection applied."

# Also lock down repo-level merge hygiene where the token allows it.
gh api --method PATCH "repos/${REPO}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=true \
  -F delete_branch_on_merge=true \
  -F allow_auto_merge=true >/dev/null 2>&1 \
  && echo "✓ Merge settings hardened (squash/rebase only, auto-delete branches)." \
  || echo "• Skipped repo merge settings (insufficient token scope) — non-fatal."

echo "▶ Verifying protection…"
gh api "repos/${REPO}/branches/${BRANCH}/protection" \
  --jq '{enforce_admins: .enforce_admins.enabled, checks: .required_status_checks.contexts, reviews: .required_pull_request_reviews.required_approving_review_count, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled, linear: .required_linear_history.enabled}'
