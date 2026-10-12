# Next Phase Prompt

## Current phase closed (fix/ia-dev-git-source-of-truth)
- 313/313 tests pass (`pnpm test`)
- `pnpm run typecheck` and `pnpm run build` clean
- `git diff --check` no whitespace errors
- Changes committed and pushed to fork (PR #2 updated)

## Technical debts resolved this phase
1. `opencode_get_messages` default bounded to last 50 messages (tail semantics documented)
2. `checkOpencodeCli` `which` spawn removed; portable `--version`-only detection
3. Stale "Author + Ranker" comment in `.ia-dev.yml.example` corrected
4. CI blockage on PR #2 documented (upstream base repo has no workflow; no admin access)

## Graphify / ECC decision — closed (2026-10-12)
- Lab research completed: Graphify + ranker merged in `ia-dev-architecture-lab` (`1db7309`, PR #62); ECC on unmerged branch `feat/graphify-ecc-context` (`69c3cf2`)
- Repeated benchmark (PR #89, 9 runs): ranked 2/3 (author timeout), +5.4% input, +19.7% cache-read vs control; conclusion: no demonstrated efficiency/reliability gain to promote ranked or add ECC
- **Decision for this bridge: keep as external lab roadmap. Do not port to bridge this phase.** Reevaluate only with new quantitative evidence showing a clear win.

## Open questions for next phase
- **CI for PR #2**: the upstream repo `yuga-hashimoto/opencode-chatgpt-bridge` has no CI workflow on main and no readable Actions policies. Either request CI activation there, or open a PR against the fork's own `main` branch.
- **AGENTS.md / PROJECT-CONTEXT.md**: these docs are now created; future phases may refine them.

## Next phase: CI for PR #2 resolution
1. Coordinate with upstream repo maintainers to activate CI on `yuga-hashimoto/opencode-chatgpt-bridge`, or open a PR against the fork's own `main` branch so `pull_request` workflows execute in the fork's own CI.
2. If CI is activated, verify `pnpm validate` passes on the fork.
3. After CI is green, the bridge phase cycle is fully closed: validate → run → verify → human review → PR.