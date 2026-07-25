# Pi upstream setup and sync

Git does not copy local remote configuration into GitHub. Every fresh clone must run the committed setup script before upstream work.

```sh
git clone --branch omb-Preview https://github.com/HaD0Yun/CozyClay.git
cd CozyClay
./scripts/setup-upstream.sh
git remote -v
```

Expected topology:

```text
origin    https://github.com/HaD0Yun/CozyClay.git (fetch/push)
upstream  https://github.com/earendil-works/pi.git (fetch)
upstream  DISABLED (push)
```

For an upstream update:

```sh
./scripts/setup-upstream.sh
git switch -c sync/pi-YYYYMMDD omb-Preview
git merge --no-ff upstream/main
npm ci --ignore-scripts
npm run build
npm run check
npm --prefix apps/cclay-extension test
```

The `apps/cclay-extension` test command above is the CozyClay bridge integration suite; run it before merging the sync branch. Never enable inherited Pi publishing or issue-management workflows as part of an upstream merge.

## Fork shape

CozyClay is an additive fork. It adds `packages/blender-protocol`, `packages/blender-tools`, `packages/director-core`, `packages/director-runtime`, `apps/*`, `blender-addon/`, and Blender scripts, and it edits no source file under `packages/{ai,agent,coding-agent,tui,server,storage}`. Keep it that way: any direct edit to an inherited Pi package turns every future sync into a source-level conflict.

The only files both sides own are `package.json`, `tsconfig.json`, `package-lock.json`, `biome.json`, `.gitignore`, and `.github/workflows/ci.yml`.

## Merge checklist

1. `package.json` — conflict in `workspaces`. Keep both `apps/*` (ours) and upstream's entries such as `packages/storage/*`. Take upstream's `scripts.build` wholesale; it tracks upstream package renames.
2. `tsconfig.json` — conflict in `compilerOptions.paths` and `include`. Keep both the upstream `@earendil-works/*` paths and the `@cclay/*` paths, and union the `include` globs.
3. `package-lock.json` — always conflicts. Do not hand-merge; take either side, then regenerate with `npm install --package-lock-only --ignore-scripts`.
4. Pi dependency ranges in `packages/blender-tools`, `packages/director-runtime`, and `apps/*` must be bumped to the new Pi version. Caret ranges on `0.x` do not span minors: `^0.80.9` does not satisfy `0.82.0`, so npm silently installs a second copy from the registry instead of linking the workspace.
5. `.github/` — upstream workflow edits must land in `.github/upstream-workflows-disabled/`, not `.github/workflows/`. Rename detection normally does this automatically; if a sync reports modify/delete on a workflow, resolve toward the disabled directory.

## API surface we depend on

The fork consumes a small, public Pi surface. Re-check these against the upstream changelog `Breaking Changes` sections before merging:

- `@earendil-works/pi-coding-agent`: `defineTool`, `createAgentSession`, `ModelRuntime`, `SettingsManager`, `SessionManager`, `createExtensionRuntime`, `ResourceLoader`, `ExtensionAPI`, `AgentSessionEvent`
- `@earendil-works/pi-ai`: `Model`, `AssistantMessage`, `InMemoryCredentialStore`
- `@earendil-works/pi-ai/compat`: `registerFauxProvider`, `fauxAssistantMessage`, `fauxToolCall`, `fauxText`, `fauxThinking`
