# Live demo launch

## Prerequisites

- Blender installed (the smoke-tested path is `/opt/homebrew/bin/blender`).
- Node.js and repository dependencies installed.
- A Codex login in `~/.gjc/agent/agent.db`, or an Anthropic OAuth token.
- An empty directory selected as `OMB_DEMO_PROJECT_DIR`.

## Launch order

1. Start Blender and bootstrap the project:
   ```sh
   OMB_DEMO_PROJECT_DIR=/path/to/demo blender --python scripts/demo/blender_bootstrap.py
   ```
2. Start the TUI (any terminal):
   ```sh
   OMB_DEMO_PROJECT_DIR=/path/to/demo scripts/demo/launch-tui.sh
   ```

Attachment is automatic: the TUI-spawned daemon writes a one-use
`attach-handoff.json` into its private runtime directory and the Blender
add-on discovers and consumes it (`bpy.ops.omb.connect()` uses the same
path from the UI). No ticket copying is involved; the TUI reissues a
fresh handoff while no Blender bridge is attached.

`OMB_NODE_EXECUTABLE` overrides Node resolution; `OMB_MODEL` overrides the default model.
Use `OMB_SKIP_ATTACH=1` for background bootstrap checks that must not attach.
