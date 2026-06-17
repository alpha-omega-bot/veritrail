# Repository Setup & Safety Guards

This document records how the Veritrail repository's long-term safety guards are
configured, so they can be reproduced and audited.

## 1. Local guard: pre-push hook

A pre-push hook runs the full CI-equivalent gate (`format:check → lint →
typecheck → test → build`) and **blocks the push** if anything fails. This is the
first line of defense — broken code never leaves a developer's machine.

Enable it once per clone:

```bash
pnpm run setup:hooks        # sets git config core.hooksPath .githooks
```

The hook lives at [`.githooks/pre-push`](../.githooks/pre-push). Emergency bypass
(discouraged): `git push --no-verify`.

## 2. Server-side guard: branch protection

Local hooks can be bypassed, so the authoritative enforcement is **server-side
branch protection** on `main`, applied via the GitHub API. It requires CI to pass
before any merge and blocks unsafe history rewrites.

Apply (idempotent; requires `gh` auth with admin on the repo):

```bash
scripts/protect-branch.sh <owner/repo> main
```

Guards applied:

| Guard                                   | Effect                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Required status checks (strict)         | `verify (node 20)`, `verify (node 22)`, `ledger integrity gate` must pass; branch must be up to date  |
| Required PR review rule (dismiss stale) | PR review protection is enabled; approving-review count is currently `0` for the solo-maintainer flow |
| Enforce for admins                      | Even admins cannot bypass the rules                                                                   |
| Block force-push                        | History on `main` cannot be rewritten                                                                 |
| Block deletions                         | `main` cannot be deleted                                                                              |
| Required linear history                 | No merge commits — squash/rebase only                                                                 |
| Required conversation resolution        | All review threads resolved before merge                                                              |

## 3. CI: the checks being enforced

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) defines the jobs whose
names are referenced as required status checks above:

- `verify (node 20)` / `verify (node 22)` — format, lint, typecheck, test
  (coverage), and build on both Node LTS lines.
- `ledger integrity gate` — runs the core's tamper-evidence suite in isolation,
  so a regression in the ledger's integrity guarantees blocks every merge.

`.github/workflows/codeql.yml` adds security scanning. Because this private repo
does not currently have GitHub Advanced Security/code scanning enabled, the
workflow publishes SARIF results as a CI artifact instead of uploading them to
GitHub code scanning.

> **Important:** the status-check _contexts_ in `protect-branch.sh` must match the
> CI job _names_ exactly. If you rename a CI job, update the script in the same PR,
> or protection will silently stop requiring it.

## 4. Recommended workflow

```bash
git switch -c feature/my-change      # never commit directly to main
# … work, with the pre-push hook guarding you …
git push -u origin feature/my-change
gh pr create                         # CI runs; review required; merge when green
```
