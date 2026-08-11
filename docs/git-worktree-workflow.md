# Git worktree workflow

This platform separates versioned source code from the live runtime:

- Bare repository: `<AI_ROOT>\platform-repo.git`
- Stable worktree: `<AI_ROOT>\worktrees\main`
- Integration worktree: `<AI_ROOT>\worktrees\integration`
- Feature worktrees: `<AI_ROOT>\worktrees\feature-*`
- Live deployment and runtime data: `<AI_ROOT>`

The live directory is intentionally **not** a Git worktree. Models, caches, databases, API keys, logs, ledgers, downloaded files, and Docker runtime state remain outside version control.

## Start a feature

Run from `<AI_ROOT>\worktrees\main` or `integration`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\new-worktree.ps1 `
  -Branch feature/my-change `
  -StartPoint integration
```

The default target becomes `<AI_ROOT>\worktrees\feature-my-change`. Open that directory as the Codex workspace for the task.

Install and validate it independently:

```powershell
.\install-all.cmd
.\test-all.cmd
```

Commit only source changes:

```powershell
git status --short
git add --all
git commit -m "feat: describe the change"
```

## Merge through integration

From the integration worktree:

```powershell
git merge --no-ff feature/my-change
.\test-all.cmd
```

After integration is verified, merge it into the stable worktree:

```powershell
git -C <AI_ROOT>\worktrees\main merge --no-ff integration
git -C <AI_ROOT>\worktrees\main tag -a vX.Y.Z -m "vX.Y.Z"
```

Do not switch the branch of a worktree that is already registered elsewhere. `git worktree list` is the source of truth.

## Deploy without touching runtime data

Deploy only from a clean, tested worktree. The helper builds the release allowlist, verifies its SHA256, backs up every changed live source file, copies without deleting target-only files, and does not restart any manager or model process:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-worktree.ps1 `
  -IncludeLocalExtensions
```

Omit `-IncludeLocalExtensions` when only the public platform package changed. Include it when `search-gateway` or its start/stop scripts changed.

Deployment backups and manifests are written below:

```text
<AI_ROOT>\artifacts\worktree-deploy-backups\<timestamp>-<commit>\
```

The deploy helper intentionally requires confirmation. It blocks dirty worktrees unless `-AllowDirty` is explicitly supplied, and it runs `test-all.cmd` unless `-SkipTests` is explicitly supplied.

## Remove a completed feature worktree

The removal helper refuses paths outside `<AI_ROOT>\worktrees`, refuses the current worktree, and blocks uncommitted changes:

```powershell
powershell -ExecutionPolicy Bypass -File <AI_ROOT>\worktrees\main\scripts\remove-worktree.ps1 `
  -Path <AI_ROOT>\worktrees\feature-my-change `
  -DeleteBranch
```

`main` and `integration` are protected from branch deletion. Use `-Force` only after reviewing uncommitted files.

## Safety rules

1. Never initialize Git in or clone over the live `<AI_ROOT>` directory.
2. Never run `git clean` against the live directory.
3. Never commit `.env`, keys, databases, runtime ledgers, model weights, caches, logs, `node_modules`, or deployment artifacts.
4. Public releases must still be built through `build-github-release.ps1` and validated after clean extraction.
5. Git rollback restores source history; deployment backups restore the exact live files that existed before a rollout.
