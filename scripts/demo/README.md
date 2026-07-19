# Live demo launch

## Prerequisites

- Blender installed (the smoke-tested path is `/opt/homebrew/bin/blender`).
- Node.js and repository dependencies installed.
- `tmux` for the interim ticket watcher.
- A Codex login in `~/.gjc/agent/agent.db`, or an Anthropic OAuth token.
- An empty directory selected as `OMB_DEMO_PROJECT_DIR`.

## Launch order

1. Start Blender and bootstrap the project:
   ```sh
   OMB_DEMO_PROJECT_DIR=/path/to/demo blender --python scripts/demo/blender_bootstrap.py
   ```
2. Start the TUI in a tmux pane:
   ```sh
   OMB_DEMO_PROJECT_DIR=/path/to/demo scripts/demo/launch-tui.sh
   ```
3. Deliver the attach ticket, using the TUI pane identifier:
   ```sh
   scripts/demo/ticket-watcher.sh session:window.pane
   ```

`OMB_ATTACH_FILE` overrides `/tmp/omb-live-attach.json` for Blender and the watcher.
`OMB_NODE_EXECUTABLE` overrides Node resolution; `OMB_MODEL` overrides the default model.
Use `OMB_SKIP_ATTACH=1` for background bootstrap checks that must not poll for a ticket.
