# Tagging v1.0.0 (human gate G7)

This document is **instructions only**. The F7 PR does **not** create the tag.

## Preconditions

1. `main` includes F7 docs (`CHANGELOG.md`, `docs/release/ACCEPTANCE-v1.md`, this file, ops runbook).
2. Review [`docs/release/ACCEPTANCE-v1.md`](./ACCEPTANCE-v1.md) — residual risks accepted.
3. Prefer running secret scan before tag:
   ```bash
   # if installed
   gitleaks detect --source . --no-git -v
   # or
   gitleaks detect --source . -v
   ```
4. Explicit human authorization: **`autorizado tag`** (or equivalent).

## Cut the tag

```bash
cd /path/to/nod-rastrackdash-wpp
git checkout main
git pull --ff-only origin main
git log -1 --oneline   # confirm expected tip

git tag -a v1.0.0 -m "RastrackDash student edition v1.0.0"
git push origin v1.0.0

gh release create v1.0.0 \
  --title "v1.0.0 — RastrackDash student edition" \
  --notes-file CHANGELOG.md
```

## Do not

- Tag from a feature branch
- Force-push tags
- Put secrets in release notes

## After tag

- Announce with link to GitHub Release + `docs/setup/README.md`
- PalmUP ops: keep private license server + NOD broker runbook in mind (`docs/ops/palmup-license-runbook.md`)
