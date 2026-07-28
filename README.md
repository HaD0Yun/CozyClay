# CozyClay

**Direct Blender with an AI agent from your terminal.**

CozyClay connects a Pi-based coding agent to a live Blender scene. Describe the
shot you want; the director can inspect the scene, stage objects and characters,
plan cameras, generate motion, and render QA frames while Blender stays open.

```text
> Put two boxers on the mat, stage a wide establishing shot, then cut
  between the second and third punch.

  inspect_project             42 objects, revision 100c68ea...
  stage_scene                 2 characters, 1 assembly         committed
  produce_directing_evidence  5 action peaks, 4 motion valleys
  apply_camera_plan           2 shots, cut at frame 161        committed
  render_qa_frames            4 frames at 640x360
```

CozyClay is not a chat panel embedded in Blender. It is a local directing
harness with revision checks, transaction boundaries, ownership rules, and
visual verification tools.

> **Alpha:** APIs, project data, and installation steps may change. Pin a
> commit when using CozyClay in an existing workflow.

## Why CozyClay

- **Works against the live scene.** The director reads the same objects,
  transforms, animation, cameras, and timeline that you see in Blender.
- **Refuses stale edits.** Scene mutations are bound to an expected revision.
  If you edit the scene while a change is being prepared, the stale change is
  rejected.
- **Keeps hand-authored work separate.** CozyClay mutates only entities it owns
  unless you explicitly adopt an existing object.
- **Verifies visually.** Viewport captures, contact inspection, directing
  evidence, and deterministic QA renders are part of the tool loop.
- **Supports generated character motion.** An optional remote
  [NVIDIA ARDY](https://github.com/nv-tlabs/ardy) installation can generate and
  constrain motion clips.

## Requirements

- macOS or Linux
- Node.js 22.19 or newer
- Blender 5.1.2 or newer
- An account or API key for a model provider supported by
  [Pi](https://github.com/earendil-works/pi)
- Optional for character motion: an SSH-accessible NVIDIA GPU machine running
  ARDY

Windows is not currently supported by the `cclay` launcher.

## Install

Manual setup is short; if you want an AI coding agent to run it for you, use
the checked prompts and safety rules in
[`docs/AI-SETUP.md`](docs/AI-SETUP.md).

```sh
git clone https://github.com/HaD0Yun/CozyClay.git
cd CozyClay
npm ci --ignore-scripts

mkdir -p ~/.local/bin
ln -s "$PWD/scripts/cclay" ~/.local/bin/cclay
```

Ensure `~/.local/bin` is on `PATH`, then check the installation:

```sh
cclay --version
cclay --help
```

The first model request may require `/login` in the TUI. Credentials and
sessions are stored per project under `.cclay/pi-agent/`.

## Quick start

Run CozyClay inside the directory that should hold the Blender project:

```sh
mkdir -p ~/BlenderScenes/my-short
cd ~/BlenderScenes/my-short
cclay
```

The launcher:

1. starts Blender with the CozyClay add-on;
2. initializes `.cclay/project.json`;
3. waits for the local bridge;
4. opens the director TUI in that project.

Then direct the scene in plain language:

```text
> Add a 4 by 4 metre mat.
> Put two Y Bots 1.2 metres apart, facing each other.
> Make the near character throw two jabs and a hook.
> Find the motion valleys and plan a wide shot followed by a close-up.
> Render QA frames and tell me what still looks wrong.
```

Useful launch options:

| Command | Purpose |
|---|---|
| `cclay` | Open the nearest CozyClay project, or initialize the current directory |
| `cclay --no-blender` | Start only the director for an already initialized project |
| `cclay --provider <name> --model <id>` | Select a Pi provider and model |
| `cclay --model <id>` | Override only the model |
| `CCLAY_PROJECT_DIR=<dir> cclay` | Open a project from another directory |
| `CCLAY_BLENDER_EXECUTABLE=<path> cclay` | Use a specific Blender executable |
| `CCLAY_PROJECTS_ROOT=<dir> cclay` | Change the project picker root |

The launcher refuses to initialize sensitive roots such as `$HOME`, `/`, and
`/tmp`. From those locations it opens a project picker instead.

## The directing loop

CozyClay works best when each turn describes one logical change:

1. **Inspect** the current revision and relevant entities.
2. **Stage** a typed operation against that exact revision.
3. **Commit or roll back** the transaction.
4. **Verify** with geometry checks, viewport captures, or QA renders.
5. **Report** the committed revision and remaining visual problems.

Manual viewport edits are allowed between turns. The next inspection observes
them and advances the revision.

Project-local state:

| Path | Contents |
|---|---|
| `.cclay/project.json` | Project identity |
| `.cclay/journal.jsonl` | Append-only revision journal |
| `.cclay/transactions/` | Interrupted transaction recovery markers |
| `.cclay/artifacts/` | Digest-addressed evidence and QA renders |
| `.cclay/motions/` | Generated motion clips |
| `.cclay/pi-agent/` | TUI sessions and provider credentials |
| `.cclay-blender-attach.log` | Blender attach and bridge diagnostics |

Do not commit `.cclay/` or the attach log. They may contain credentials, local
paths, scene metadata, and model transcripts.

## Character motion with ARDY

Everything except generated character motion works without ARDY.

For motion generation, prepare a remote ARDY checkout at the commit pinned in
[`scripts/ardy/UPSTREAM_BASE`](scripts/ardy/UPSTREAM_BASE), install its
dependencies and checkpoints, and configure the SSH target:

```sh
export CCLAY_ARDY_HOST=user@gpu-host
export CCLAY_ARDY_REPO=ardy

scripts/ardy/sync-to-box
scripts/ardy/sync-to-box --apply
```

Generate a clip from inside a CozyClay project:

```sh
cclay-ardy-generate \
  "A person waves both hands above their head." \
  --duration 3
```

CozyClay sends the prompt over SSH and copies the generated `.npz` into
`.cclay/motions/`. It does not upload the Blender scene.

Motion workflow:

1. Generate one continuous clip, using repeated `--segment` arguments for
   behaviour transitions.
2. Run `preflight_motion` to measure travel, height changes, and contacts.
3. Apply the clip with `stage_scene apply_motion`.
4. Verify it in the viewport and with contact checks.
5. Regenerate with positional, orientation, pose, or path constraints when a
   contact must land on scene geometry.

ARDY does not see the scene, and its skeleton has no fingers. Scene placement,
facing, and hand shapes remain separate directing operations.

See [the ARDY integration guide](scripts/ardy/README.md) and the bundled
[`ardy-motion` skill](packages/director-runtime/skills/ardy-motion/SKILL.md) for
the full workflow.

## Architecture

```text
Blender
  CozyClay add-on
  viewport, timeline, checkpoints, transaction execution
                    |
                    | authenticated loopback WebSocket
                    v
CozyClay Pi extension
  director runtime, Blender tools, project journal
                    |
                    +-- model provider
                    +-- optional ARDY host over SSH
```

Typed Blender tools include:

- `inspect_project`, `inspect_entity`, and `inspect_relations`
- `inspect_pose_contacts`
- `capture_viewport` and `read_image`
- `stage_scene`
- `produce_directing_evidence` and `apply_camera_plan`
- `preflight_motion`
- `render_qa_frames`

The director also has Pi's general tools, including filesystem reads, shell
commands, and web access. Prefer the typed Blender tools because they enforce
revision and transaction rules, but treat CozyClay as a local coding agent with
shell access to the selected project directory. It is not a sandbox.

Read [`SECURITY.md`](SECURITY.md) before using CozyClay on sensitive projects.

## Repository layout

| Path | Purpose |
|---|---|
| `blender-addon/cclay/` | Blender add-on and transaction executor |
| `apps/cclay-extension/` | Pi extension and local bridge |
| `packages/blender-protocol/` | Closed wire schemas and scene formats |
| `packages/blender-tools/` | Model-facing Blender tool implementations |
| `packages/director-core/` | Revisions, manifests, journals, and artifacts |
| `packages/director-runtime/` | Director session, prompt, and turn loop |
| `packages/{ai,agent,coding-agent,tui,server,storage}/` | Vendored, unmodified Pi runtime |
| `scripts/ardy/` | ARDY integration sources, patches, and tests |

CozyClay is an additive fork of
[earendil-works/pi](https://github.com/earendil-works/pi). The vendored Pi
packages remain unmodified so they can be refreshed as a single upstream
snapshot. See [`docs/UPSTREAM-SYNC.md`](docs/UPSTREAM-SYNC.md).

## Development

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run check

npm --prefix packages/blender-protocol test
npm --prefix packages/blender-tools test
npm --prefix packages/director-core test
npm --prefix packages/director-runtime test
npm --prefix apps/cclay-extension test
python3 -m unittest discover -s blender-addon/tests
```

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.
Repository-specific agent instructions are in [`AGENTS.md`](AGENTS.md).

## Status and limitations

- CozyClay is alpha software and has no stable project format yet.
- The launcher currently targets macOS and Linux.
- Blender must remain open for live directing.
- Character motion requires a separately managed ARDY GPU host.
- Model output is not trusted to be correct; review the scene and rendered
  evidence before keeping a change.
- General agent tools are not sandboxed.

## License and attribution

CozyClay's own code is licensed under
[GPL-3.0-or-later](LICENSE). Scenes, renders, and motion clips produced with
CozyClay are not covered by the program's GPL license.

Third-party components keep their original terms:

- The vendored Pi packages are MIT-licensed.
- Patches against NVIDIA ARDY are Apache-2.0 licensed.

See [`LICENSES/`](LICENSES/) for the complete notices and scope.
