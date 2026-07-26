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
- Character motion only: an ssh-reachable CUDA machine running NVIDIA ARDY (see [Character motion](#character-motion-ardy))

## Quick start

```sh
git clone https://github.com/HaD0Yun/CozyClay.git
cd CozyClay
npm install --ignore-scripts
./scripts/setup-upstream.sh   # optional: only needed to sync from upstream Pi

# put the launcher on PATH
ln -s "$PWD/scripts/cclay" ~/.local/bin/cclay
ln -s "$PWD/scripts/cclay-ardy-generate" ~/.local/bin/cclay-ardy-generate   # optional: character motion

cd ~/BlenderScenes/my-short   # any directory becomes a project
cclay
```

`cclay` resolves the project directory, launches Blender with the CozyClay add-on attached, waits for the project to initialize, and drops you into the director TUI. Run `cclay --no-blender` to attach Blender yourself.

## Using it

One command is the whole entry point. `cclay` picks the project, launches Blender with the add-on, waits for the add-on to seed `.cclay/project.json`, and starts the director in that directory.

| invocation | what it does |
|---|---|
| `cclay` | project is the nearest ancestor holding `.cclay/project.json`, otherwise the current directory |
| `cclay` from `~`, `/`, or `/tmp` | refuses to turn a sensitive root into a project; lists your `~/BlenderScenes` projects to continue, or takes a name for a new one |
| `cclay --no-blender` | director only; attach Blender yourself. The project must already exist |
| `cclay --model <id>` | override the model |
| `cclay --provider <name> --model <id>` | any provider Pi supports; run `/login` once in the TUI |
| `CCLAY_PROJECT_DIR=<dir> cclay` | point at another project from anywhere |
| `CCLAY_BLENDER_EXECUTABLE=<path> cclay` | choose a specific Blender build instead of the detected one |
| `CCLAY_PROJECTS_ROOT=<dir> cclay` | where the project picker looks (default `~/BlenderScenes`) |

Credentials are project-local: each project keeps its own sessions and auth under `.cclay/pi-agent/`, so logging in once per project is expected. The launcher defaults to `--provider openai-codex` and imports a Codex OAuth record from `~/.gjc/agent/agent.db`; without that file, pass `--provider` explicitly and log in from the TUI.

### The loop

You direct in plain language; the director does the tool work and reports the revision it committed.

```
> put a 4x4 m mat on the floor, two Y_BOTs facing each other 1.2 m apart
> make the near one throw two jabs, then a hook
> give me a wide establishing shot that cuts to a close-up on the motion valley between the second and third punch
> render QA frames and tell me what still looks wrong
```

Useful habits:

- Say the size or the spacing when you care about it. "A desk" is a guess; "a 1.2 m desk at 0.75 m high" is a plan.
- One logical change per turn. The director is built to stage, verify, and report — not to hide ten mutations behind one summary.
- Keep working in the viewport while it runs. Your hand edits move the revision, the next `inspect_project` picks them up, and a mutation staged against a revision that moved is refused rather than applied.
- Objects you made by hand are not the director's to touch. It mutates only entities it owns, until you tell it to `adopt_entity` one of yours.

What accumulates in the project directory:

| path | what it is |
|---|---|
| `.cclay/project.json` | project identity, seeded by the add-on. The extension refuses to load without it |
| `.cclay/journal.jsonl` | append-only revision journal |
| `.cclay/transactions/` | prepared-transaction markers. One left behind means a mutation was interrupted |
| `.cclay/artifacts/` | QA renders and evidence documents, addressed by digest |
| `.cclay/motions/` | generated motion clips, re-appliable after a rollback |
| `.cclay/pi-agent/` | project-local Pi sessions and credentials |
| `.cclay-blender-attach.log` | add-on attach log; the first thing to read when Blender never connects |

## Character motion (ARDY)

Animation is generated, not hand-keyframed: CozyClay drives NVIDIA [ARDY](https://github.com/nv-tlabs/ardy), a text-to-motion diffusion model that outputs 20 fps clips, and bakes the result onto a CozyClay character with `stage_scene apply_motion`.

ARDY needs a CUDA GPU, so it does not run beside your scene. CozyClay treats it as a remote generator: the prompt goes out over ssh, an `.npz` comes back into `.cclay/motions/`, and nothing else crosses the wire.

### Pointing CozyClay at a box

1. On the GPU machine, clone [`nv-tlabs/ardy`](https://github.com/nv-tlabs/ardy) at the commit pinned in [`scripts/ardy/UPSTREAM_BASE`](scripts/ardy/UPSTREAM_BASE), install it into a `.venv/` inside that checkout, and fetch the checkpoints per upstream's instructions (`CHECKPOINTS_DIR`). Upstream is deliberately not vendored here; pinning which commit we build against is.
2. Point CozyClay at it. Every call runs `ssh -o BatchMode=yes`, so key-based access is required:

   ```sh
   export CCLAY_ARDY_HOST=my-gpu-box   # default 100.90.2.101
   export CCLAY_ARDY_REPO=ardy         # checkout on that box, default $HOME/ardy
   ```

3. Push CozyClay's ARDY-side sources onto it:

   ```sh
   scripts/ardy/sync-to-box           # dry run: what differs, in both directions
   scripts/ardy/sync-to-box --apply
   ```

   The sync refuses to run when the box is not at the pinned commit, and a dry run also lists work the box has that this repo does not. Details in [scripts/ardy/README.md](scripts/ardy/README.md).

Then confirm the path end to end. Run it from inside a CozyClay project — the generator stages the clip into that project and refuses to run anywhere else:

```sh
cclay-ardy-generate "A person waves both hands above the head." --duration 3
# {"motion_id":"a-person-waves-...","frames":60,"fps":20,"duration_s":3,
#  "path":".cclay/motions/a-person-waves-....npz","continuity":{...}}
```

### Asking for motion

Ask in plain language — "make him run in and bow" is motion work, and the director loads the bundled `ardy-motion` skill before it writes a prompt. The steps it then runs are worth recognizing, because you will see them in the transcript:

1. **Generate.** `cclay-ardy-generate "<prompt>" --duration <s>`. A real behaviour transition (run, then bow) is not two clips: it is one continuous rollout, requested as repeated `--segment "<prompt>" <seconds>` and chained through the model's own history conditioning.
2. **Preflight.** `preflight_motion` measures travel distance, height change, and contact windows on the clip before it touches the scene, so a clip that misses the geometry is caught instead of baked and eyeballed afterwards.
3. **Bake.** `stage_scene apply_motion`. One clip per character — the newest apply replaces that character's action, sets the scene to 20 fps, and extends the frame range to fit.
4. **Verify.** Viewport captures or QA renders, contact checks, then a correction loop.

Worth knowing before you argue with a result:

- **Prompts are English, third person, one sentence per behaviour:** "A person bows down and then stands upright." Chaining several behaviours into one long sentence gets clauses silently dropped by the model.
- **ARDY never sees your scene.** A measured number written into the prompt biases the model; it does not bind it. When contacts must land on geometry that already exists — stair treads, a seat, a platform edge — the fix is a constrained regeneration (`--constrain <frame> <joint> <x> <y> <z>`, in npz space: Y-up, metres, relative to the motion's own start), not another seed.
- **Placement and facing are not motion.** Transform the armature first; the baked root motion travels relative to that transform.
- **Fingers are authored, not generated** — ARDY's skeleton has none. `hand_shapes` sets one shape per side for the whole clip; `hand_track` keys a hand that opens on approach and closes on contact.
- **Never splice, crossfade, or hand-edit an `.npz`.** Reword, re-segment, reseed, or constrain. Clips stay in `.cclay/motions/`, so re-applying after a rollback costs nothing.

The full rule set the director follows, including the constrained-regeneration and hand-tracking details, is [`packages/director-runtime/skills/ardy-motion/SKILL.md`](packages/director-runtime/skills/ardy-motion/SKILL.md). Read it before driving the generator by hand.

Without a box, everything else works: motion is the only thing that needs one.

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
- **Closed mutation surface.** Every scene change goes through the typed ops; there is no path that mutates Blender outside a revision-checked, committed transaction. The director also has Pi's general tools (read, bash, web) — that is how it drives the motion generator and runs Blender directly when a typed op does not exist — so treat it like any agent with a shell, in a project directory you chose.

## Tools

CozyClay's typed tools, on top of Pi's general tool set:

| Tool | What it does |
|---|---|
| `inspect_project` | Compact scene summary: objects, transforms, cameras, lights, assemblies |
| `inspect_entity` | Full detail for one entity — bone hierarchy, fcurves, materials |
| `inspect_relations` | World-space geometry relations: bounds, support planes, sibling spacing |
| `inspect_pose_contacts` | Whether a character's deformed foot sole actually touches declared support geometry, with the measured gap per frame |
| `capture_viewport` | Fast visual QA — the live viewport, or several synthesized angles of one entity, as small JPEGs |
| `read_image` | Pull a screenshot or reference image into the conversation |
| `produce_directing_evidence` | Derive action peaks, motion valleys, and subject samples from the scene |
| `preflight_motion` | Analyze a generated motion archive before it is baked |
| `stage_scene` | Transactional scene building: primitives, rigged characters, parenting, motion |
| `apply_camera_plan` | Commit a validated multi-shot camera plan |
| `render_qa_frames` | Deterministic 640x360 QA renders for an exact revision |

## Commands

The director TUI is Pi's, so every Pi slash command works. CozyClay adds one:

| Command | What it does |
|---|---|
| `/btw <question>` | Ask a side question without derailing the turn in flight. It answers from the current session context, sends no tools, and writes nothing to the session history, so a staging turn that is holding a Blender transaction open keeps its context clean. Esc cancels it while it streams and dismisses the answer afterwards. |

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
- [Character motion rules](packages/director-runtime/skills/ardy-motion/SKILL.md) — the skill the director reads before writing a motion prompt
- [ARDY-side sources](scripts/ardy/README.md) — what runs on the GPU box, and how it stays in sync with this repo
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
