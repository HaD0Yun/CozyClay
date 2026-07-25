# ARDY-side sources

Everything CozyClay runs on the ARDY GPU box lives here, so the box holds no
source that this repository does not. Before this directory existed, roughly
6,000 lines existed only on that box: 13 modified upstream files and an untracked
suite of our own. The repository contained the *output* of that work — the name
`ARDY_CinematicCamera` is baked into committed fixtures and snapshot tests — while
the code that produced it was one disk failure from gone.

## Upstream provenance

Upstream is [`nv-tlabs/ardy`](https://github.com/nv-tlabs/ardy), Apache-2.0,
released 2026-07-10 (SIGGRAPH 2026, TOG 45(4) art. 86). The box is a clone of it.

```
UPSTREAM_BASE = 693f74d13b3d04a0a22ce127ee79c929dd89756b   ("Initial commit")
```

Upstream itself is **not vendored**. Cloning it is the box's job; pinning which
commit we build against is ours, and that pin lives in `UPSTREAM_BASE`.

## Layout

| path | what it is | why it is shaped this way |
|---|---|---|
| `UPSTREAM_BASE` | the upstream commit everything here is written against | a patch series is meaningless without the commit it applies to |
| `upstream-patches/*.patch` | our changes to files ARDY owns | carried as patches, not vendored copies, so an upstream bump shows up as a patch conflict instead of silently losing their changes or ours |
| `interactive_demo/` | modules that are entirely ours, dropped into ARDY's demo tree | not upstream code, so a patch would be the wrong shape; these are plain files |
| `tests/` | tests for the modules above | they run on the box, against the box's `.venv`, because they import `ardy` |
| `cclay_constrained_generate.py`, `cclay_sequence_generate.py` | the two generation entry points cclay drives over ssh | already tracked here before this reorganisation |
| `assets/skeletons/cskel27/` | binary assets the patched upstream reads by name | `ardy/viz/core_skin.py` resolves `fist_bind_vertices.npy` by filename, so the patch is inert without the file beside it |
| `sync-to-box` | pushes this directory onto the box | see below |

`interactive_demo/` and `tests/` are Apache-2.0-adjacent only in that they import
ARDY; they are our own work and carry no upstream copyright.

## Direction of truth: repo, then box

The box used to be authoritative and the repo a partial copy. That is now
inverted, and the inversion is the point of this directory:

```sh
scripts/ardy/sync-to-box            # dry run: shows exactly what would change
scripts/ardy/sync-to-box --apply    # push the repo's state onto the box
```

`sync-to-box` refuses to run when the box's `HEAD` is not `UPSTREAM_BASE`, because
applying our patches to a different upstream commit would either fail loudly or,
worse, apply cleanly to code that has moved underneath them.

A dry run reports divergence in both directions. Forward, it lists vendored copies
that differ or are missing on the box. Reverse, it lists untracked files the box
has that this directory does not carry (unbacked-up work), and tracked drift in
the files the upstream patch owns — read from the patch itself, so an added or
removed hunk never silently drops out of the check.

The upstream patch is a first-class part of the sync, not a manual footnote. The
dry run classifies it against the box tree, derived from git itself:

- **applied** — already applied; `--apply` is a no-op for it (idempotent).
- **pending** — not yet applied; `--apply` applies it for real.
- **drifted** — neither forward nor reverse applies; the box has edited a
  patch-owned file. `--apply` aborts and names the conflict rather than forcing.
  Resolve the conflict here, in this repo, never by `git checkout`/`reset`/`-f`
  on the box.

The two checks that distinguish these are `git apply --check` (forward) and
`git apply --reverse --check` (reverse); the comment in `sync-to-box` documents
which combination means which state.

Editing on the box is still fine for exploration — it is a GPU box and iterating
there is the fast path — but anything that should survive has to come back here.
A dry run is also the cheapest way to find out what the box has that this
directory does not.

## Refreshing the upstream patch

When work on the box changes files ARDY owns:

```sh
ssh "$CCLAY_ARDY_HOST" 'cd ~/ardy && git diff' \
  > scripts/ardy/upstream-patches/0001-cclay-demo-integration.patch
```

When upstream itself is bumped, update `UPSTREAM_BASE`, re-apply the patch, and
resolve conflicts there rather than on the box — the conflict is the signal that
upstream changed something we depend on.
