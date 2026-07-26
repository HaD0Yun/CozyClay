# CozyClay

**An AI directing harness for Blender.** Talk to a director in your terminal; it reads your live Blender scene, stages objects, plans camera moves, and renders QA frames — through a transactional bridge that never mutates your scene outside a revision-checked, committed transaction.

CozyClay is not a chat window bolted onto Blender. Every mutation is a two-phase transaction bound to an exact scene revision, every entity it creates carries an ownership stamp, and every camera plan is validated against digest-authorized evidence before a single keyframe lands.

> Status: alpha. The protocol, the add-on, and the tool surface are all still moving. Pin a commit if you build on it.

## What it looks like

```
$ cd ~/BlenderScenes/my-short
$ cclay

> put the two boxers on the mat facing each other, then give me a
  wide establishing shot that cuts to a close-up on the valley
  between the second and third punch

  inspect_project      42 objects, revision 100c68ea…
  stage_scene          + 2 characters, + 1 assembly    committed
  produce_directing_evidence   5 action peaks, 4 motion valleys
  apply_camera_plan    2 shots, cut at frame 161       committed
  render_qa_frames     4 frames @ 640x360
```

Blender stays open the whole time. You keep working in the viewport; the director sees what you see.

## Requirements

- Node.js >= 22.19
- Blender >= 5.1.2
- An LLM provider account (any provider Pi supports)

## Quick start

```sh
git clone https://github.com/HaD0Yun/CozyClay.git
cd CozyClay
npm install --ignore-scripts
./scripts/setup-upstream.sh   # optional: only needed to sync from upstream Pi

# put the launcher on PATH
ln -s "$PWD/scripts/cclay" ~/.local/bin/cclay

cd ~/BlenderScenes/my-short   # any directory becomes a project
cclay
```

`cclay` resolves the project directory, launches Blender with the CozyClay add-on attached, waits for the project to initialize, and drops you into the director TUI. Run `cclay --no-blender` to attach Blender yourself.

## How it works

```text
Blender UI
  CozyClay add-on (blender-addon/cclay)
    viewport + timeline context · selection · undo checkpoints
                    ⇅ authenticated local WebSocket, ordered stream
CozyClay extension (apps/cclay-extension) + Pi AgentSession
  Director Runtime   prompt · tool allowlist · turn loop
  Director Core      project state · revisions · manifests
  Blender Bridge     correlated two-phase transactions · artifacts
                    ⇅
DirectorProject journal + exact recovery marker + .blend evidence
```

The add-on owns the Blender main thread. The bridge speaks a closed protocol: every message is schema-validated in both directions, unknown fields fail closed, and a mutation cannot start without a negotiated session marker plus an active parent request.

### Safety model

- **Revision binding.** Mutating tools take an `expected_revision_id`. A scene that moved under the director is rejected, not overwritten.
- **Two-phase transactions.** Prepare, then commit. A failed commit rolls the ownership stamp back.
- **Ownership stamps.** The director refuses to touch entities it does not own (`STAGE_SCENE_TARGET_NOT_CCLAY_OWNED`), so your hand-authored objects are safe.
- **Digest-authorized evidence.** Camera plans validate against an evidence document pinned by SHA-256. Caller-supplied metadata cannot authorize a plan.
- **Closed tool surface.** The embedded director session runs a fixed allowlist; there is no shell, no filesystem write, no network tool.

## Tools

| Tool | What it does |
|---|---|
| `inspect_project` | Compact scene summary: objects, transforms, cameras, lights, assemblies |
| `inspect_entity` | Full detail for one entity — bone hierarchy, fcurves, materials |
| `inspect_relations` | World-space geometry relations: bounds, support planes, sibling spacing |
| `capture_viewport` | Fast visual QA — the active viewport as a JPEG |
| `read_image` | Pull a screenshot or reference image into the conversation |
| `produce_directing_evidence` | Derive action peaks, motion valleys, and subject samples from the scene |
| `preflight_motion` | Analyze a generated motion archive before it is baked |
| `stage_scene` | Transactional scene building: primitives, rigged characters, parenting, motion |
| `apply_camera_plan` | Commit a validated multi-shot camera plan |
| `render_qa_frames` | Deterministic 640x360 QA renders for an exact revision |

## Packages

| Package | Description |
|---|---|
| [`@cclay/protocol`](packages/blender-protocol) | Closed wire schemas: bridge messages, scene manifests, camera plans, evidence |
| [`@cclay/director-core`](packages/director-core) | Project state, canonical revisions, manifest hashing, artifact store |
| [`@cclay/blender-tools`](packages/blender-tools) | The model-facing Blender tool implementations |
| [`@cclay/director-runtime`](packages/director-runtime) | Director session, prompt, tool allowlist, turn loop |
| [`apps/cclay-extension`](apps/cclay-extension) | Pi extension that binds the tools to a live Blender bridge |
| [`blender-addon/cclay`](blender-addon/cclay) | The Blender add-on: main-thread execution, transactions, QA render |

## Relationship to Pi

CozyClay is built on [earendil-works/pi](https://github.com/earendil-works/pi) and vendors it as an additive fork: `packages/{ai,agent,coding-agent,tui,server,storage}` are upstream Pi, untouched. All CozyClay code lives in new packages, so upstream updates merge with only config-level conflicts.

To pull a newer Pi, follow [docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md).

## Documentation

- [Runtime architecture](docs/BLENDER-HARNESS-ARCHITECTURE.md) — the full design, protocol, and invariants
- [Scene snapshot v2](docs/SCENE-SNAPSHOT-V2.md) — canonical scene serialization
- [Provider security](docs/G013-PROVIDER-SECURITY.md)
- [Upstream sync](docs/UPSTREAM-SYNC.md)

## Development

```sh
npm install --ignore-scripts
npm run check                                       # lint, format, types
python3 -m unittest discover -s blender-addon/tests # Blender add-on suite
npm --prefix packages/blender-protocol test         # per-package suites
```

The add-on suite runs headless and covers the pure-Python logic; tests that need a real Blender binary skip themselves when one is not on PATH.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR, and [AGENTS.md](AGENTS.md) if you drive this repo with a coding agent.

## License

MIT. See [LICENSE](LICENSE).

Third-party code this repository carries or derives from:

| component | license | shape |
|---|---|---|
| [Pi](https://github.com/earendil-works/pi) — `packages/{ai,agent,coding-agent,tui,server,storage}` | MIT, Copyright (c) 2025 Mario Zechner and Pi contributors | vendored, unmodified |
| [ARDY](https://github.com/nv-tlabs/ardy) — `scripts/ardy/upstream-patches/*.patch` | Apache-2.0, Copyright (c) NVIDIA Corporation | not vendored; these patches modify files ARDY owns, so they are derivative works of Apache-2.0 code and carry its terms, including the attribution and modification-notice requirements of section 4 |

Everything else under `scripts/ardy/` (`interactive_demo/`, `tests/`, the `cclay_*_generate.py` entry points) is CozyClay's own work and imports ARDY without deriving from it.
