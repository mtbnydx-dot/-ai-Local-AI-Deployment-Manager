# Release Policy

`build-github-release.ps1` is the only supported way to create a public release archive.

For every product change:

1. Modify and test the working project.
2. Run `powershell -ExecutionPolicy Bypass -File .\build-github-release.ps1` from the project root.
3. Extract the generated ZIP into a clean directory, run `install-all.cmd`, then run `test-all.cmd`.
4. Publish the generated ZIP and its `.sha256` file from `artifacts/github-release/`.
5. Never publish models, caches, logs, secrets, PID files, runtime ledgers, databases, local proxy profiles, screenshots, or `node_modules`.

The build uses an explicit allowlist and performs identity and credential-pattern checks before creating the archive.
