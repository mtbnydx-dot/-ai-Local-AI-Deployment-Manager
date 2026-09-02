# Release Policy

## Git worktree boundary

- `<AI_ROOT>\platform-repo.git` is the canonical bare Git repository.
- `<AI_ROOT>\worktrees\main` is the stable source worktree.
- `<AI_ROOT>\worktrees\integration` is the integration worktree. Feature work belongs in additional worktrees under `<AI_ROOT>\worktrees`.
- `<AI_ROOT>` itself remains the live deployment and runtime root. It is intentionally not a Git worktree.
- A commit or merge never deploys files to the live root. Use `scripts\deploy-worktree.ps1`, which builds and verifies an allowlisted release, creates a rollback backup, and does not restart services.
- Runtime data, local configuration, models, logs, caches, databases, secrets, TTS environments/reference voices/generated audio, and `node_modules` never belong in Git.

`build-github-release.ps1` is the only supported way to create a public release archive.

For every product change:

1. Modify and test the working project.
2. Run `powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1` from the project root.
3. Extract the generated ZIP into a clean directory, run `install-all.cmd`, then run `test-all.cmd`.
4. Publish the generated ZIP and its `.sha256` file from `artifacts/github-release/`.
5. Never publish models, caches, logs, secrets, PID files, runtime ledgers, databases, local proxy profiles, screenshots, TTS runtime environments, or `node_modules`.

The build uses an explicit allowlist and performs identity and credential-pattern checks before creating the archive.
