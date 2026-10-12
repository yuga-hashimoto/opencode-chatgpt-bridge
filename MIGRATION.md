# IA DEV Bridge — Architecture & Migration Guide

## Project Location

**Current project:** `/Users/davidsegade/IA/IA-DEV` (this repository)

This is the durable, version-controlled location. The previous `/private/tmp/opencode-chatgpt-bridge` was ephemeral and should not be used.

---

## Architecture: Git Physical as Source of Truth

### Core Principle

**The physical filesystem + Git is the only authoritative source of truth.**

- `opencode` is an **editing agent** — it proposes and applies changes
- The bridge's `repo_git_status` and `repo_git_diff` tools read the **physical Git repository** directly
- `opencode_vcs_status` and `opencode_get_diff` return opencode's **internal view** which may not match the physical filesystem
- A writing task is **only complete** when `git status` and `git diff` show physical changes

### Verification Flow

```
ChatGPT → IA DEV Bridge → opencode → filesystem real → Git real → tests → diff verificable → revisión humana
```

The `ia_dev_run_task` tool implements this flow:
1. Validates repo exists and is a real Git repo
2. Verifies Git top-level matches requested path
3. Requires clean repo (by default)
4. Blocks writing to main/master (by default)
5. Loads the `.ia-dev.yml` profile — the repo must have one and its `write_paths` must not be empty
6. Captures initial HEAD and status
7. Creates NEW opencode session on current server
8. Sends prompt, waits for terminal state using correct status detection
9. Compares physical HEAD, staged and unstaged patches, and untracked content hashes/modes before and after execution
10. Returns success only for idle/completed with a changed physical snapshot; error/cancelled and incomplete verification fail

`requireClean` defaults to true and is an entry precondition. With `requireClean:false`, unchanged preexisting edits do not count as task changes. Unreadable untracked files prevent successful verification. The snapshot comparison detects repository changes, but does not attribute concurrent edits by other processes to a particular agent.

---

## Session-Server Binding (Critical)

### The Problem

Multiple opencode servers can run on different ports. Sessions created on one server **cannot** be queried from another.

### The Solution

Every bridge session stores its `baseUrl` (the opencode server it was created on). Before any session-specific operation, the bridge compares it with the current managed server:

```
persistedSession.baseUrl === currentManagedServer.baseUrl
```

If they differ, the bridge attempts a **fail-closed recovery** (see `src/opencode/recovery.ts`):

1. Ask the current managed server for `session/{opencodeSessionId}`
2. The returned session id must equal the persisted `opencodeSessionId`
3. The returned `session.directory` must resolve (realpath) to the persisted `repoPath`
4. Only then the persisted `baseUrl` is rebound to the current server

Recovery outcomes:
- Session missing on the managed server → the server's own error propagates, nothing is rebound
- Id or project mismatch → **`SESSION_PROJECT_MISMATCH`** error, nothing is rebound

**Operations that verify the binding:**
- `opencode_get_session_status`
- `opencode_send_message`
- `opencode_get_messages`
- `opencode_get_diff`
- `opencode_abort`
- `opencode_respond_permission`
- `opencode_wait_for_session`
- Any operation using `opencodeSessionId`

**Operations that do NOT verify (repo-level):**
- `opencode_read_file`
- `opencode_find_files`
- `opencode_vcs_status`
- `opencode_capabilities`
- `list_projects`
- `opencode_start`
- `repo_git_status`
- `repo_git_diff`

### Practical Implications

- A restart that changes the managed server port **rebinds existing sessions automatically**, as long as the session still exists and belongs to the same project directory
- Stale sessions that no longer exist on the server still fail, now with the server's own error instead of `SERVER_MISMATCH`
- A session whose project directory no longer matches is rejected with `SESSION_PROJECT_MISMATCH`
- Recovery never crosses projects: the directory check always runs before rebinding

---

## IA DEV Profile (`.ia-dev.yml`)

`ia_dev_run_task` refuses to launch unless the target repo contains a valid `.ia-dev.yml` (copy `.ia-dev.yml.example`). The schema lives in `src/config/schema.ts`, loading and access checks in `src/security/profile.ts`.

- `version` must be `"2.1"`; `profile` is one of `code-change|bugfix|refactor|test|docs|config`; `goal` needs at least 10 characters
- `models.author` and `models.reviewer` are required, must be different, and must belong to the engine-owned free-model registry.
- Every tool that can put a model on the wire enforces this: `ia_dev_run_task`, `opencode_launch_task` and `opencode_send_message`. Explicit `providerID`/`modelID` overrides must be supplied together and must name a registry model. When no override is given, the profile author is used and a profile must exist.
- Before any prompt is submitted, the bridge reads the managed server's `/provider` inventory and verifies the model is on a connected provider with an advertised cost block whose input, output and any cache/`context_over_200k` rates are exactly zero. A missing cost block, a missing provider, an ambiguous provider record, a model id that does not match its key, or a deprecated model all block execution. Unparseable inventory blocks execution.
- `cache_read` and `cache_write` must be explicitly advertised as exactly zero. Absence is treated as unverifiable, not free: the provider may simply not report a cache tariff, and the bridge cannot prove the rate is zero. A model that omits either field is rejected at preflight. `context_over_200k` is optional because it only applies to models whose context limit exceeds 200k; when present, all its rates (including cache) must also be explicitly zero.
- **There is no author fallback.** The registry holds two models and the reviewer is the only alternative, so a quota rejection (HTTP 429/402) stops the task and reports that the prompt was not resubmitted. Re-adding a fallback requires registering a third free model that is discovered and verified against the live inventory.
- Free-only is verified twice: the advertised tariff before submission, and after completion from the `providerID`/`modelID`/`cost` that OpenCode records on each assistant message. A turn on a non-registered model, or a reported cost above zero, makes the task fail even if it ended idle/completed. The post-hoc check fails closed on missing evidence: a message without `info`, an `info` without a `role`, an assistant message without `providerID`/`modelID`/`cost`, or a session with zero assistant messages all block success rather than assuming freeness.
- These are the guards the bridge itself applies. They are not an agent sandbox: see the limits below.
- `paths` uses the 4-list permission model: `context_paths` (readable), `write_paths` (modifiable, empty = no writes allowed), `protected_paths` (never written), `sensitive_paths` (never read)
- `limits` and `commands` are optional and fall back to defaults
- The tool fails before sending any prompt when the profile is missing or `write_paths` is empty

---

## OpenCode Status Detection

The bridge handles both current and legacy status formats:

```typescript
// Current format
{ type: "idle" }
{ type: "busy" }
{ type: "running" }
{ type: "completed" }
{ type: "error" }
{ type: "cancelled" }

// Legacy format
{ status: "idle" | "completed" | "error" | "cancelled" | "running" | "busy" }
```

**Terminal states:** `idle`, `completed`, `error`, `cancelled`
**Non-terminal states:** `busy`, `running`

Helpers in `src/types.ts`:
- `isTerminalOpencodeStatus(status)` — returns true for terminal states
- `isBusyOpencodeStatus(status)` — returns true for busy/running states

---

## MCP Tools Summary

### Bridge & Project Tools
| Tool | Purpose |
|------|---------|
| `bridge_health` | Check bridge config and managed opencode processes |
| `list_projects` | List Git repos under allowed roots |

### Session Tools (verify server binding, recover after restart)
| Tool | Purpose |
|------|---------|
| `opencode_start` | Start/reuse opencode server for a repo |
| `opencode_stop` | Stop managed opencode servers |
| `opencode_create_session` | Create new opencode session → returns `bridgeSessionId` |
| `opencode_list_sessions` | List bridge sessions |
| `opencode_get_session_status` | Get session status (verifies binding, recovers after restart) |
| `opencode_send_message` | Send prompt to session (verifies binding, recovers after restart) |
| `opencode_get_messages` | Fetch session messages (verifies binding, recovers after restart) |
| `opencode_get_diff` | Fetch session diff (verifies binding, recovers after restart) |
| `opencode_abort` | Abort running session (verifies binding, recovers after restart) |
| `opencode_respond_permission` | Respond to permission prompt (verifies binding, recovers after restart) |
| `opencode_wait_for_session` | Poll until terminal state (verifies binding, recovers after restart) |
| `opencode_launch_task` | Create session + send prompt + wait + return diff |

### Repo-Level Tools (no server binding)
| Tool | Purpose |
|------|---------|
| `opencode_read_file` | Read file via opencode |
| `opencode_find_files` | Fuzzy find files via opencode |
| `opencode_vcs_status` | Get opencode's VCS status (informational only) |
| `opencode_capabilities` | List agents, commands, providers |

### Git Physical Tools (AUTHORITATIVE)
| Tool | Purpose |
|------|---------|
| `repo_git_status` | **Authoritative** Git status from physical filesystem |
| `repo_git_diff` | **Authoritative** Git diff from physical filesystem |

### End-to-End Task Tool
| Tool | Purpose |
|------|---------|
| `ia_dev_run_task` | Full task execution with Git verification — **returns success only if Git shows changes** |

---

## Git Physical Layer (`src/git/repository.ts`)

All functions use `execFile` (no shell, no unsafe interpolation):

| Function | Purpose |
|----------|---------|
| `validateGitRepo(repoPath)` | Verify path exists, is Git repo, top-level matches |
| `getGitStatus(repoPath)` | Full status: branch, HEAD, clean, porcelain, untracked, modified, staged |
| `getCurrentBranch(repoPath)` | Current branch name |
| `getHead(repoPath)` | Current HEAD commit hash |
| `getWorktreeTopLevel(repoPath)` | Git top-level directory |
| `getGitDiff(repoPath)` | Unstaged diff |
| `getGitDiffIncludingUntracked(repoPath)` | Unstaged + staged + untracked as separate sections |
| `assertClean(repoPath)` | Throw if uncommitted changes exist |
| `assertNotMain(repoPath)` | Throw if on main/master branch |

---

## Security Model (Unchanged)

- `opencode` bound to `127.0.0.1` only
- Repositories must be under `OPENCODE_BRIDGE_ALLOWED_ROOTS`
- Bridge bearer token (`OPENCODE_BRIDGE_TOKEN`) for exposed/tunneled use
- URL-token fallback for connector UIs without header support
- No arbitrary shell execution exposed
- Diffs are first-class for review before commit

---

## Migration from `/private/tmp`

If you have an existing instance in `/private/tmp`:

```bash
# 1. Stop old bridge
pnpm -C /private/tmp/opencode-chatgpt-bridge run uninstall-service

# 2. Copy config
cp /private/tmp/opencode-chatgpt-bridge/.env /Users/davidsegade/IA/IA-DEV/.env

# 3. Sessions persist automatically in ~/.opencode-chatgpt-bridge/sessions.json
#    (create new sessions if the managed server baseUrl changes)

# 4. Build & start in new location
cd /Users/davidsegade/IA/IA-DEV
pnpm install
pnpm run build
pnpm run install-service
pnpm run service-status
```

---

## Verification Checklist

After any changes, run:

```bash
pnpm run typecheck  # TypeScript strict mode
pnpm test           # Unit tests
pnpm run build      # Production build
```

All three must pass.

---

## Development Workflow

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run validate  # runs all three
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/git/repository.ts` | Physical Git operations (source of truth) |
| `src/types.ts` | Type definitions, status helpers |
| `src/mcp/tools.ts` | MCP tool registrations |
| `src/mcp/results.ts` | Tool result helpers |
| `src/security/paths.ts` | Path validation, allowed roots |
| `src/opencode/process.ts` | opencode process management |
| `src/state/store.ts` | Bridge session persistence |
| `tests/mcp-tools.test.ts` | Tool behavior tests |

---

## License

MIT
OpenCode may omit idle sessions from `/session/status`. The bridge only infers completion when the latest assistant message has a completion timestamp and `finish: stop`, without an error, and a second status check still shows no active session. Missing status alone never implies success.


## Bounded OpenCode HTTP requests

The client limits ordinary HTTP requests (including provider inventory, status and async prompt acknowledgment) to 30 seconds by default. `OpencodeClientOptions.requestTimeoutMs` configures that limit. Synchronous generation and slash commands allow at least 10 minutes because their HTTP response can include the full model turn. The deadline covers both response headers and body.

A deadline aborts the HTTP connection only: it does not cancel an OpenCode session or resend a task. `OPENCODE_REQUEST_TIMEOUT` means a mutation may already have been accepted; inspect its session before any manual retry. Successful and failed requests clear their timers.


## Profile path precedence

`sensitive_paths` deny both reads and writes, even when `context_paths` or `write_paths` also match. `protected_paths` deny writes. Relative paths are normalized for matching (separators and `.` segments); absolute paths, parent traversal and NUL bytes are rejected before normalization. The filesystem access validators and `opencode_read_file` also reject symlink components, including internal and dangling links, before delegating access. For writes, a path that does not exist yet is a legitimate creation target; for reads it is denied, because a missing file is not readable and a directory is not a readable file. The checks do not read link targets. They are preflight checks, not a filesystem sandbox: concurrent path replacement can still create a race, and direct agent access requires separate enforcement.

## What these guards do and do not cover

The bridge validates the calls it receives. It does not contain the agent.

Covered by the bridge:
- Which repo, file and model a tool call may touch, resolved against `.ia-dev.yml`.
- Which models may reach the wire, verified before submission and again from observed usage afterwards.
- Which paths a finished task actually dirtied, checked against the write policy.

Not covered by the bridge:
- **Filesystem TOCTOU.** `isSafeRepoFilePath` lstats each component in the bridge process; the OpenCode server performs the actual read in a different process. A component swapped for a symlink between the check and the use is not caught. Use OS-level isolation for that.
- **Direct agent access.** Anything the OpenCode agent does on its own, with its own tools and permissions, is outside every check here. `write_paths` is enforced by refusing to *report success* for an out-of-policy change; it is not a write fence. Enforcing writes requires an agent-side permission layer (`agent.permission.edit`, OS sandbox or container).
- **Preflight vs execution.** The `/provider` inventory is a point-in-time advertisement. The authoritative signal is the post-hoc check over assistant message metadata; if that fetch fails, the task fails rather than assuming freeness.
- **Paths already dirty before the run** are fingerprinted (worktree hash, index entry, mode, existence) at task start and again at task end. A path that keeps its fingerprint is not attributed to the task; a path whose fingerprint changed is attributed and re-checked against `write_paths`. A path the task reverts to its pre-run state leaves no final diff, so the revert itself is not attributed to any path: the task reports `gitChanged: true` with an empty `changedPaths`. Attribution is based on final physical state, not on every action the task took.
- **Cost attribution outside the session.** Only turns recorded in the inspected session are checked.

Quota handling: only HTTP 429 and 402 are treated as a definitive quota rejection, using the structured status rather than the response body, which is provider-controlled text. Deadlines, 5xx and transport errors are reported as an unknown submission outcome; the prompt is never resubmitted automatically because acceptance cannot be proven either way.
