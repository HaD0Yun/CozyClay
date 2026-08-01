# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.
- Never modify `packages/blender-protocol/src/stage-scene-ops.generated.ts`, `blender-addon/cclay/stage_scene_ops.generated.py`, `packages/blender-protocol/src/manifest-fields.generated.ts`, or `blender-addon/cclay/manifest_fields.generated.py` directly; update `packages/blender-protocol/src/op-registry.json` or `scripts/generate_stage_scene_ops.py` instead, then regenerate.

## Graphify Code Graph

- The repository-local code graph is `graphify-out/graph.json`.
- Before broad architecture exploration, dependency tracing, impact analysis, or a non-trivial multi-file change, query the existing graph first with `graphify query`, `graphify path`, `graphify affected`, or `graphify explain` from the repository root.
- Do not rebuild the graph for ordinary questions. Use the existing graph as an index to identify relevant files and symbols.
- Graphify is not the source of truth. Verify every relevant result against the current source with read, search, AST, and LSP tools before editing.
- Simple, known-location fixes do not require a graph query.
- The graph is code-only. Documentation, PDFs, images, JSON fixtures, and SQL are not semantically indexed.
- After non-trivial code changes, run `graphify update .` so later sessions do not query a stale graph.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Provider model data (`packages/ai/src/providers/data/`) is gitignored and generated. A fresh clone must run `npm run hydrate:model-data` once, or `tsgo` reports hundreds of `unknown`/`never` type errors across `packages/ai`.
- The extension loader hands extensions the workspace `dist/` builds, not `src/`. After merging upstream Pi, run `npm run build` or extensions fail to load against a stale `dist` (e.g. `setDefaultStreamFn is not a function`).
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- CozyClay packages use `node --test`, not vitest: run `npm --prefix packages/<name> test`. The Blender add-on suite is `python3 -m unittest discover -s blender-addon/tests`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the invariants a PR must not break.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Say which area is affected (`protocol`, `director-core`, `director-runtime`, `blender-tools`, `blender-addon`, `extension`).

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing the director TUI with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Upstream Pi

`packages/{ai,agent,coding-agent,tui,server,storage}` are vendored from `earendil-works/pi` unmodified. That is what keeps upstream syncs conflict-free.

- Never edit a file under those packages. If a Pi change is genuinely required, say so and stop; it goes upstream, not here.
- Never run `npm run release:*`, `npm run publish*`, or `npm run version:*`. Those are inherited Pi release scripts that publish `@earendil-works/*` to npm. CozyClay does not publish them.
- Never re-enable anything in `.github/upstream-workflows-disabled/`.
- `packages/*/CHANGELOG.md` belongs to Pi. Do not add CozyClay entries there.
- To sync a newer Pi, follow `docs/UPSTREAM-SYNC.md`. Pi dependency ranges in the CozyClay packages must be bumped in the same commit: caret ranges on `0.x` do not span minors.

## Invariants

Do not weaken these without the user explicitly asking. They are the reason CozyClay is safe to point at a real scene.

- Wire schemas are closed in both directions, with one explicit exception: inbound (add-on -> director) manifests may carry a bounded, UTF-8-byte-and-depth-limited, non-semantic extensions bucket under versioned `x-*` namespace keys, excluded from typed validation, from the canonical hash (enforced by a compile-time `ManifestForHashing` boundary type plus a behavioral non-participation test), and from every semantic/authorization decision, tracked by its own separate director-computed digest. Every other field, in both directions, remains closed.
- Mutating tools require and verify `expected_revision_id`.
- Mutations use the durable prepare/commit boundary and roll back Blender scene state on errors. `execute_blender_python` is ON BY DEFAULT with a per-project off switch and warning; successful scripts are committed as ordinary project mutations, while external side effects such as files, network, and processes cannot be rolled back.
- The director may mutate any entity except one stamped `cclay.locked_by_human`. At ownership-inversion cutover, only entities foreign to the current project (owner absent, or owned by a different project) were auto-locked; entities already owned by the current project were and remain unlocked. `execute_blender_python` is explicitly exempt from entity-lock enforcement because arbitrary Python cannot be statically bounded. `adopt_entity` remains available for explicit-claim semantics.
- Camera plans use the same expected_revision_id staleness check every mutating tool uses; directing-evidence analysis is still produced and recorded for audit, but no longer gates authorization.
- The embedded director session keeps a fixed tool allowlist, generated from a single curated catalog (`EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS`) shared with the extension's tool registration so the two cannot drift; `execute_blender_python` is included ON BY DEFAULT, disableable per project, and checked at session construction either way. `ardy_regenerate` is an explicit typed model capability in that same catalog: it may only publish to and await the host-owned durable regeneration queue, which remains the sole path into `ArdyMotionKernel`, `ArdyArchiveService`, and committed `apply_motion`. It must never invoke wrappers, mutate archives, or use Blender Python directly. `ardy_generate` remains unavailable until it has an equivalent closed typed contract and host-queue implementation.
- The Python add-on and the TypeScript protocol must produce identical canonical revisions, including for declaratively-registered single-property fields (Stage 4a); parity for those fields is verified by a hand-pinned numeric oracle and a cross-language execution comparison over generated fixtures, not by the generator's own determinism, which proves consistency but not correctness on its own.
- `ArdyArchiveService` (module boundary inside `director-runtime`) validates cskel27/Y-up/FPS/replay invariants at write time and structural well-formedness at read time via typed schemas — this is real for WELL-BEHAVED callers (regeneration queue runner, ARDY services) and prevents accidental/malformed writes on that path. It provides NO authenticated caller identity, NO adversarial tamper resistance, and NO proof an archive entry was genuinely ARDY-produced. Threat table (permanent, stated in `AGENTS.md` verbatim): any process running as the same OS user as Blender/director-runtime — including a script executed via `execute_blender_python` — can read every file under `.cclay/` including archive entries and any key material; write/overwrite archive files directly, bypassing `ArdyArchiveService` entirely; produce a validly-"signed" forged entry if HMAC diagnostics are retained; and directly pose/mutate the rig in the live scene exactly as it always could, with or without ARDY involvement. None of this is prevented by typed services, module boundaries, or same-process signing. HMAC signing, if retained, is scoped explicitly as non-adversarial corruption/tamper-EVIDENCE diagnostics only (disk errors, pipeline bugs, interrupted writes) — never described as security. Real OS-level isolation (separate OS user/service account/credential broker) and proactive drift-detection tooling (comparing live rig pose against archive claims) are both explicitly OUT OF SCOPE for this plan, permanently, not deferred pending future evidence — this is the reconciled, final decision, not an open item.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
