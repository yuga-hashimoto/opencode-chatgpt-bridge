# IA DEV — Project Context

## Branch & State
- **Current branch:** `fix/ia-dev-git-source-of-truth` (HEAD `817ed51`, just after commit `e6dc40b`)
- **Working tree:** clean
- **Open PR:** #2 on `yuga-hashimoto/opencode-chatgpt-bridge`, mergeable, head SHA `e6dc40b` = fork tip (pushed)
- **AGENTS.md:** creado en esta fase como reglas permanentes del proyecto

## Architecture: Git Physical as Source of Truth
- The physical filesystem + Git is the only authoritative source of truth.
- `opencode` is an editing agent; bridge tools (`repo_git_status`, `repo_git_diff`) read the physical repo directly.
- `opencode_vcs_status` and `opencode_get_diff` return opencode's internal view, which may not match the physical filesystem.
- A writing task is only complete when `git status` and `git diff` show physical changes.
- Verification flow: ChatGPT → IA DEV Bridge → opencode → filesystem real → Git real → tests → diff verificable → human review.

## `opencode_get_messages` — Limit Semantics (verified against live opencode 1.18.35)
- `?limit=N` returns the **last N messages (tail)** in chronological order.
- `resolveSessionStatus` (src/opencode/status.ts:12) depends on this: `getMessages(sessionId,1)` + `.at(-1)` → latest message.
- **Default change:** omitting `limit` now returns the last 50 messages instead of the full transcript (unbounded payload). Aligned with `run_task`'s `messageLimit` default of 50.
- Description updated: "`limit` uses tail semantics (most recent N). Defaults to the last 50 messages when omitted."

## `checkOpencodeCli` — Portability fix
- Removed the `which` spawn and `path` field from `OpencodeCliStatus`. The binary is detected solely via `opencode --version`; any valid executable (e.g., `process.execPath`) correctly reports `installed: true`.
- Setup guide line now reads `opencode: installed (v1.17.7)` without a path suffix.
- Portable test added: `tests/opencode-setup.test.ts` verifies with `process.execPath`.

## CI — exact block on PR #2
- `.github/workflows/ci.yml` exists **only** on the fix branch (commit `9a5edee`); `origin/main` (`34f69c3`) and the fork's default branch have no workflows.
- PR #2 is a **cross-repo** PR: base = upstream `yuga-hashimoto/opencode-chatgpt-bridge`, head = fork `davidsegade/opencode-chatgpt-bridge:fix/ia-dev-git-source-of-truth`.
- For fork PRs, `pull_request` workflows execute in the **base** repo; the base repo has no CI workflow on main, and its Actions policies are not readable (403 / EOF on run listings).
- `check-runs` on the PR head commit: **total 0** — no check ever ran.
- **Nothing local can produce checks on PR #2** without human action on the upstream repo (e.g., requesting CI activation or opening a PR against the fork's own main). Documented in MIGRATION.md.

## Graphify / ECC — decision closed 2026-10-12
- **Zero references** anywhere in IA-DEV (src, tests, .github, README, MIGRATION.md, git history across all branches).
- Lab `origin/main` **has** Graphify + deterministic ranker merged (`1db7309`, PR #62; ranker fix `e8e7068`, PR #80): locked venv `graphifyy==0.9.80` (`toolchain/graphify-requirements.lock`), fail-closed version check, per-attempt fresh extraction, deterministic ranker bounded to 8 files / 6000 chars, `validateGraph` fail-closed.
- **ECC** exists only on the lab's unmerged branch `feat/graphify-ecc-context` (`69c3cf2`): engine-owned `config/project-memory.json` + planning text, gated `IA_DEV_CONTEXT=graphify-ecc`, ≤1500-char memory, "never expands task or permission", "untrusted navigation evidence".
- **Verdict benchmark (PR #89, 9 runs, 2026-10-09)**: ranked 2/3 accepted (one author timeout at 180s), median input +5.4% / cache-read +19.7% / slower wall-clock vs control. Recorded conclusion: no demonstrated efficiency or reliability gain to promote ranked or add ECC.
- **Decision closed:** keep as external lab roadmap. Integration plan (opt-in, off-by-default, invariants) lives in NEXT-PHASE-PROMPT.md. No port to bridge this phase. Reevaluate only with new quantitative evidence showing a clear win.

## Stale comment fixed
- `.ia-dev.yml.example:74`: `"Context budget for Author + Ranker"` → `"Context budget for Author model"` (the Ranker component does not exist in this codebase).