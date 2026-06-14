# Sync Policy

`github-release` is the GitHub-ready release mirror.

For every product change:

1. Modify and test the working project.
2. Run `sync-github-release.cmd`.
3. Verify `github-release` contains the same functional source files.
4. Do not publish models, caches, logs, secrets, PID files, runtime ledgers, databases, or `node_modules`.

The sync script also removes runtime leftovers from the release mirror after copying.
