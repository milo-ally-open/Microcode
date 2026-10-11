# Microcode Git Workflow Specification

**Status:** Implemented (v0.1)
**Version:** 0.1
**Date:** 2026-09-28

## 1. Purpose

Microcode MUST provide a first-party `/git` workflow for the common local Git tasks that users currently perform through shell commands. The workflow MUST make repository state visible, make selected-file operations easy, and keep mutations explicit and reviewable.

This specification covers the `/git` TUI command and the reusable repository layer under `src/git`. It does not replace Git, the existing Bash tool, or the existing worktree Agent tool.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 2. Product research

### 2.1 Codex

Codex exposes a dedicated `/review` flow for reviewing uncommitted changes, a commit, or a comparison against a base branch. Its CLI guidance emphasizes inspecting commands and diffs in the terminal; its product workflow also treats repository branches and Git worktrees as first-class execution context. Microcode SHOULD follow this separation: Git state and changes are directly inspectable, while review is a distinct read-only workflow rather than an implicit side effect of commit.

### 2.2 Claude Code

Claude Code's `/diff` reads the current working tree, including edits made outside the current conversation. Its interactive documentation says the diff view refreshes after Claude edits a file or runs a shell command. Claude Code also documents Git commit as a user-invoked skill that runs Git commands; it does not present a complete native Git command suite as the core interaction model.

### 2.3 Design implications for Microcode

- `/git` SHOULD be an interactive command menu for common repository operations, with concise direct subcommands for repeat users.
- Git status and diff MUST read the live repository when requested; UI state MUST NOT be treated as the source of truth.
- Review, worktree management, and ordinary repository operations MUST remain separate workflows.
- Multi-file stage and unstage operations SHOULD use the existing Space-to-select, Enter-to-confirm interaction.

## 3. Scope and command surface

`/git` with no argument MUST open a concise action menu containing Status, Diff, Add, Commit, Pull, and Push. Less frequent operations remain available as direct `/git` subcommands and MUST NOT crowd this menu. The command surface MUST support:

| Action | Direct form | Behavior |
| --- | --- | --- |
| Status | `/git status` | Show current branch, upstream, ahead/behind counts, and staged, unstaged, and untracked files. |
| Working diff | `/git diff` | Show unstaged tracked changes. |
| Staged diff | `/git diff --staged` | Show staged changes. |
| Branches | `/git branches` | List local branches and allow selecting one to switch to. |
| Create branch | `/git branch create <name>` | Create and switch to a local branch. |
| Switch branch | `/git branch switch <name>` | Switch to an existing local branch. |
| Delete branch | `/git branch delete <name>` | Delete a merged local branch with Git's safe-delete behavior after confirmation. |
| Add | `/git add [paths...]` | Add named paths, or open multi-select for unstaged/untracked paths. `/git stage` remains an alias. |
| Unstage | `/git unstage [paths...]` | Unstage named paths, or open multi-select for staged paths. |
| Discard | `/git discard [paths...]` | Discard selected tracked working-tree edits or remove selected untracked files after confirmation. |
| Commit | `/git commit [message]` | Commit staged changes only. An omitted message MUST return focus to the composer with `/git commit ` ready for editing. |
| History | `/git log` | Show a bounded list of recent commits. |
| Fetch | `/git fetch` | Fetch and prune remote-tracking refs after confirmation. |
| Pull | `/git pull` | Pull with fast-forward-only semantics after confirmation. |
| Push | `/git push` | Push the current branch after confirmation. |
| Stash | `/git stash` | Save working-tree and index changes with an optional message. |
| Stash list | `/git stash list` | List saved stashes. |
| Stash apply/pop | `/git stash apply [ref]`, `/git stash pop [ref]` | Apply or apply-and-remove a selected stash. |

Unknown subcommands MUST show usage and MUST NOT be forwarded as arbitrary Git arguments. `/git` MUST work as a built-in command in autocomplete and through direct text entry.

## 4. Repository discovery and API

`src/git` MUST expose a reusable `GitRepository` service opened from the current working directory. Opening a repository MUST resolve and retain the Git top-level directory. If the current directory is outside a repository, `/git` MUST show a concise actionable error and MUST NOT search child directories for a repository.

The service MUST expose typed results for repository status, changed paths, and branches. At minimum, status metadata MUST include:

```ts
interface GitRepositoryStatus {
  root: string
  branch: string
  upstream?: string
  ahead: number
  behind: number
  changes: GitFileChange[]
}

interface GitFileChange {
  path: string
  indexStatus: string
  worktreeStatus: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}
```

The implementation MUST parse NUL-delimited Git output where paths are consumed so spaces, Unicode, and unusual path characters do not corrupt selection. Rename/copy status MUST not create a phantom selectable path for the source path.

## 5. Execution and safety

- Git MUST be invoked with an executable plus an argv array. Implementations MUST NOT interpolate user input into a shell command string.
- Git work MUST run against the resolved repository root, even if a child directory launched Microcode.
- Git output MUST have a bounded buffer and a visible error path; truncation MUST be identified instead of silently presented as complete.
- Branch names and path arguments MUST be passed as individual arguments. Paths MUST follow a `--` separator and use literal pathspec handling. Path operations MUST reject absolute paths, repository-root targets, and paths that escape the repository root.
- `/git status`, `/git diff`, `/git branches`, `/git log`, and `/git stash list` are read-only and MAY run while the Agent is busy.
- Any operation that changes the index, working tree, branch, stash, or remote state MUST be blocked while the Agent is busy. The busy state MUST be checked again when a picker confirms an action.
- Stage and unstage MUST change only the selected paths. Staging MUST NOT implicitly commit.
- Commit MUST use only already staged changes. It MUST NOT run `git add -A` or include unstaged paths implicitly.
- Branch deletion MUST use the safe `git branch -d` form. Force deletion and force push MUST NOT be exposed by the first version.
- Pull MUST use `--ff-only`; it MUST NOT create a merge commit or start an unattended rebase.
- Fetch, pull, push, discard, and stash pop MUST present an explicit confirmation before execution when initiated from the action menu. Direct subcommands are explicit user intent but still MUST display the exact operation before running if arguments would cause data loss or remote changes.
- Discard MUST show selected paths and require confirmation. It MUST NOT run an unrestricted `git clean` or reset the entire repository.
- `/git` MUST preserve normal Git credential-helper behavior and MUST NOT read, store, or display credential values.

## 6. Interactive behavior

The action picker MUST use the existing TUI `SelectList` conventions and return focus to the composer after selection or cancellation. The primary menu MUST remain limited to Status, Diff, Add, Commit, Pull, and Push. Less frequent branch, stash, unstage, and discard operations remain accessible through direct subcommands. Add/stage and unstage pickers MUST use the existing `MultiSelectList`: Space toggles paths, Enter applies the complete selection, Escape cancels without changes, and the displayed checked state MUST represent the current index state.

Status output MUST distinguish staged, unstaged, and untracked paths, and MUST show detached HEAD clearly. Diff and history output MUST be bounded to a reasonable terminal/session length and state when content is truncated. Branch switch and stash pickers MUST mark the current branch or selected stash and MUST refresh the resulting status after an operation.

After each successful mutation, Microcode MUST refresh repository status and the footer branch indicator. Errors MUST leave the UI usable and return focus to the composer. No Git operation may claim success when its Git process returned a non-zero exit code.

## 7. Relationship to existing Git features

- `GitWorkTreeSystem` and the Agent's `worktree` tool remain responsible for isolated worktree lifecycle and integration. `/git` MUST NOT silently merge or remove managed worktrees.
- `GitBranchReader` remains the footer's branch source but MUST share repository-root semantics with the new Git layer where practical.
- The Bash tool remains available for advanced Git commands and commands outside this stable `/git` contract.
- GitHub pull-request creation, hosted review submission, conflict-resolution UI, submodule management, rebase/cherry-pick, and arbitrary Git passthrough are outside v0.1.

## 8. Testing requirements

Tests MUST use temporary repositories and MUST cover:

1. Opening a repository from a nested directory and failing clearly outside Git.
2. Parsing clean, staged, unstaged, untracked, deleted, renamed, and whitespace-containing paths.
3. Branch listing, create, switch, and safe deletion behavior.
4. Stage, unstage, and discard affecting only selected paths.
5. Commit requiring a message and committing only the staged set.
6. Pull refusing non-fast-forward updates and push/fetch forwarding Git errors without hiding them.
7. Stash list, apply, and pop behavior.
8. Direct `/git` subcommand parsing, unknown-command handling, cancellation, busy checks, and confirmation for remote/destructive operations.

Tests MUST not contact a real remote or depend on global Git user configuration. Remote behavior MUST be exercised with local bare repositories.

## 9. Acceptance criteria

The v0.1 implementation is complete when:

- `/git` is discoverable and opens the action menu.
- All actions in Section 3 work through the menu and their listed direct forms.
- Status and diffs reflect changes made by Microcode, an external editor, or shell commands when opened/refreshed.
- Multi-file stage/unstage is cancellable and applies only the confirmed paths.
- Network and destructive operations have the specified safeguards.
- Focused Git service and TUI command tests pass, along with the repository test suite and build.

## 10. Research sources

- [Codex CLI documentation](https://developers.openai.com/codex/cli) — terminal workflow and the dedicated review interaction.
- [Codex review workflow](https://developers.openai.com/blog/mastering-codex-remote-for-engineering) — `/review` for local changes or comparison with a branch; review and diff as an inspectable pre-ship step.
- [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) — `/diff` reads the working tree and refreshes after edits and shell commands; the diff view presents changed paths and line counts.
- [Claude Code slash commands](https://code.claude.com/docs/en/slash-commands) — user-invoked Skills can run scoped Git commands such as add, commit, and status.
