# Live demo launch

## Prerequisites

- Blender installed (the smoke-tested path is `/opt/homebrew/bin/blender`).
- Node.js and repository dependencies installed.
- A model-provider account supported by Pi. Run `/login` in the director TUI
  on first use.
- An empty directory selected as `CCLAY_DEMO_PROJECT_DIR`.

## Launch order

1. Start Blender and bootstrap the project:
   ```sh
   CCLAY_DEMO_PROJECT_DIR=/path/to/demo blender --python scripts/demo/blender_bootstrap.py
   ```
2. Start the director TUI (any terminal):
   ```sh
   cd /path/to/demo && cclay
   ```

Attachment is automatic: `cclay` launches Pi with the `apps/cclay-extension` Pi
extension, which writes `.cclay/pi-bridge.json` and the Blender add-on consumes it
on `bpy.ops.cclay.connect()`. No ticket copying is involved.

`CCLAY_MODEL` overrides the default model.
Use `CCLAY_SKIP_ATTACH=1` for background bootstrap checks that must not attach.
