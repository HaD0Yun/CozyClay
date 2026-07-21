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
2. Start the director TUI (any terminal):
   ```sh
   cd /path/to/demo && omb
   ```

Attachment is automatic: `omb` launches Pi with the `apps/omb-extension` Pi
extension, which writes `.omb/pi-bridge.json` and the Blender add-on consumes it
on `bpy.ops.omb.connect()`. No ticket copying is involved.

`OMB_MODEL` overrides the default model.
Use `OMB_SKIP_ATTACH=1` for background bootstrap checks that must not attach.
