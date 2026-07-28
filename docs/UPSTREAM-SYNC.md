# Syncing the Pi snapshot

CozyClay vendors selected packages from
[`earendil-works/pi`](https://github.com/earendil-works/pi):

- `packages/ai`
- `packages/agent`
- `packages/coding-agent`
- `packages/tui`
- `packages/server`
- `packages/storage`

These directories must remain unmodified. CozyClay-specific code belongs in
`packages/director-*`, `packages/blender-*`, `apps/cclay-extension`, and
`blender-addon`.

## Why this is a snapshot, not a merge

The public CozyClay repository starts from a clean root commit so that private
development branches, pull requests, and historical objects are not part of the
public history. It therefore has no Git ancestry in common with Pi.

Do not run `git merge upstream/main`. Refresh the vendored directories from a
reviewed Pi checkout as one snapshot commit instead.

## One-time remote setup

```sh
./scripts/setup-upstream.sh
git remote -v
```

Expected remotes:

```text
origin    https://github.com/HaD0Yun/CozyClay.git
upstream  https://github.com/earendil-works/pi.git
```

## Refresh procedure

1. Start from a clean CozyClay branch.
2. Fetch Pi and inspect its release notes and diff before copying anything.

   ```sh
   git fetch upstream --tags
   git log --oneline --decorate -20 upstream/main
   git worktree add --detach ../pi-upstream upstream/main
   ```

3. Replace only the six vendored package directories listed above with their
   counterparts from `../pi-upstream`.
4. Review root-level Pi changes separately. Integrate only changes required by
   the refreshed packages, such as workspace dependencies, TypeScript settings,
   scripts, or lockfile metadata. Do not replace CozyClay's README, licenses,
   workflows, package identity, or release scripts.
5. Confirm that no CozyClay edits remain inside the vendored package
   directories:

   ```sh
   git diff -- packages/ai packages/agent packages/coding-agent \
     packages/tui packages/server packages/storage
   ```

   The diff should be explainable entirely by the old and new Pi snapshots.

6. Update CozyClay package dependency ranges in the same change. Caret ranges
   on `0.x` packages do not cross minor versions.
7. Regenerate and verify dependency metadata:

   ```sh
   npm install --package-lock-only --ignore-scripts
   node scripts/generate-coding-agent-shrinkwrap.mjs
   node scripts/generate-coding-agent-install-lock.mjs
   npm ci --ignore-scripts
   npm run hydrate:model-data
   ```

8. Run the release checks:

   ```sh
   npm run check
   ./test.sh
   ```

9. Run the CozyClay-specific suites:

   ```sh
   npm --prefix packages/blender-protocol test
   npm --prefix packages/blender-tools test
   npm --prefix packages/director-core test
   npm --prefix packages/director-runtime test
   npm --prefix apps/cclay-extension test
   python3 -m unittest discover -s blender-addon/tests
   ```

10. Launch `./scripts/cclay --help`, `./scripts/cclay --version`, and a real
    Blender project before committing.
11. Commit the refresh as one change. Include the exact upstream Pi commit SHA
    in the commit body.
12. Remove the temporary worktree:

    ```sh
    git worktree remove ../pi-upstream
    ```

## Conflict policy

If a refresh requires editing a vendored Pi package, stop and make that change
upstream first. Carrying a CozyClay-only patch in those directories makes later
snapshot review unreliable and obscures third-party attribution.

If a Pi root change conflicts with CozyClay's product configuration, preserve
the CozyClay version and port only the minimum required behaviour.
