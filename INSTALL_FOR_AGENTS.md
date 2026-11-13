# CozyClay: install and run guide for AI agents

You are an AI agent. A user gave you this repository and asked you to install CozyClay, run it, or
connect to it. Follow this file. The [README](README.md) is the short version for people.

CozyClay is a previs studio that runs in a browser tab. The user blocks a scene, poses
characters and cuts cameras. The studio then exports the shot for an AI video model. You install it
with npm. You do not need a GPU, Python, a model download or a build step.

## 1. Check the requirements

| Need | Check | If it fails |
| --- | --- | --- |
| Node.js 22.19 or newer | `node --version` | Install Node 22 LTS or newer. Do not continue on an older Node. |
| npm (or bun) | `npm --version` | It comes with Node. |
| A Chromium-based browser (Chrome, Edge, Brave, Arc) | Ask the user | Safari and Firefox are not supported. |

## 2. Install and start (normal case)

Do not clone the repository unless the user wants to change the source code. The npm package
contains the built studio.

```sh
npx -y cozyclay --no-star
```

- This is a long-running server. Start it in the background and keep it running.
- It is ready when it prints `CozyClay is running at http://127.0.0.1:5180/app/`.
- It opens the default browser. Add `--no-open` when there is no screen, and give the user the URL.
- `--port 5200` serves on another port. Use it when the output is `port 5180 is taken`.
- `--no-star` stops the "star the repo" question when the process exits. An agent cannot answer it.

For a permanent install, run `npm install -g cozyclay`. Then `cclay` and `cozyclay` are the same
command. `cclay update` installs the latest release.
`cclay update --check` installs nothing. It prints the current version, the latest version and
the install kind, then exits `0` when up to date, `10` when an update is available, and `11` when
it cannot tell (offline, or checks turned off).
`cclay update --off` stops the update line and the Studio chip for good; `cclay update --on` undoes it.

Tell the user:

- The URL to open, in a Chromium browser.
- **Assets › Characters** adds a character, and the timeline at the bottom holds the shots.
- `Cmd/Ctrl+B` opens the Agent panel. In that panel the user signs in with a ChatGPT account, or
  chooses a model from another provider (section 5).

## 3. Control the studio yourself

Pick one surface. Do not use two that start a live hub on the same port (see "One hub per port").

### a. Terminal agent (coding agent with a shell): `cclay live`

Use this when you have a shell and the studio from step 2 is running. You need a browser tab open
on the studio URL, because the tab is the editor.

```sh
npx -y cozyclay live status --wait          # wait for an editor tab; required first step
npx -y cozyclay live inspect --scope scene  # read before you edit
npx -y cozyclay live capture --out shot.png # check the result as an image
```

The loop: wait for the editor. Read the scene. Apply one change (`arrange-objects`,
`arrange-characters`, `frame-shot`, `patch`, or `run <command>`). Verify it (`verify`, `capture`).
Each edit returns a receipt, and `undo --receipt <id>` takes it back. The output is one JSON
object per command. Exit codes: 0 ok, 1 editor or receipt error, 2 usage, 3 no hub, 4 workspace,
5 timeout or uncertain apply, 6 stale scene or busy target.

- Look at the result with `capture` PNGs. Do not screenshot the browser window.
- `UNCERTAIN_APPLY`: inspect the scene before you try again. Do not repeat the edit blindly.
- `npx -y cozyclay live --help` lists every verb.
- Full guide with worked sessions: [`docs/agent-cli.md`](docs/agent-cli.md).

### b. MCP client (Claude Desktop, Claude Code, Cursor, any MCP client)

Add this server to the client's MCP config, then restart the client:

```json
{
  "mcpServers": {
    "cozyclay": { "command": "npx", "args": ["-y", "cozyclay", "mcp"] }
  }
}
```

For Claude Code: `claude mcp add cozyclay -- npx -y cozyclay mcp`.

- The first start installs the MCP SDK (about 95 packages). This takes some time once.
- Without an editor tab, the scene, camera, prompt and project-file tools work in memory.
- With an editor tab connected, the tools move the visible viewport. `live_status` tells you if
  a tab is connected. `capture_frame`, `apply_batch`, `import_mesh`, `studio_commands` and
  `studio_run` need a connected tab.
- Tool list and protocol: [`mcp/README.md`](mcp/README.md).

### One hub per port

The studio (`cozyclay`) and the MCP server (`cozyclay mcp`) each try to host the live hub on
port 5184. The second one to start loses the port and does not report an error:

- MCP server second: it works in memory only and does not move the editor.
- Studio second: its Agent panel has no hub.

To run both, give them different ports, with `COZYCLAY_LIVE_PORT` set in each one's environment.
To drive a running studio from a shell, use `cclay live` (it connects to the hub and does not host
one).

## 4. Make motion

Motion is compiled in the browser, not generated. You write a motion spec (key poses, hand
anchors, props, walks), compile it with `motion.compile`, and read the QA report (collisions, foot
slide, reach, contacts). Spec format and loop: [`docs/motion3-agent-guide.md`](docs/motion3-agent-guide.md).
Motion works on rigged characters in Animation projects. Capsule figures and Storyboard projects
refuse it with `TARGET_NOT_READY` or `NOT_IN_MODE`.

## 5. Agent panel models (optional)

The Agent panel inside the studio can use ChatGPT or Claude (sign in in the panel), Anthropic,
OpenAI, Google Gemini, MiniMax, MiniMax (China), OpenRouter, CLIProxyAPI, or an OpenAI-compatible
server such as LM Studio or Ollama (connect it in the panel with its address). For an API-key
provider, set the key in the environment of the process that starts the studio
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `MINIMAX_API_KEY`,
`MINIMAX_CN_API_KEY`, `OPENROUTER_API_KEY`, `CLIPROXY_API_KEY`), or let the user paste it in the
panel. Keys go to
`~/.config/cozyclay/providers.json` (mode 0600). Never print a key or put it in a command line
that is logged. Details: [`docs/agent-cli.md`](docs/agent-cli.md#models-and-providers).

## 6. From source (only to change the code)

```sh
git clone https://github.com/HaD0Yun/CozyClay.git
cd CozyClay
npm install
npm run dev        # studio, agent sidecar and live hub on http://127.0.0.1:5180/app/
npm test           # build, then every verification file
```

Contribution rules (branches, PR checks, the lint ratchet) are in [`AGENTS.md`](AGENTS.md).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `port 5180 is taken` | Another studio runs. Open its URL, or start with `--port 5200`. |
| `live status` shows `"editors":[]` | No tab is open on the studio URL, or the tab uses a different live port. Open or reload the tab. |
| `NO_EDITOR` on an edit | Same as above. Run `live status --wait` first. |
| Blank page or WebGL error | The browser is not Chromium, or hardware acceleration is off. |
| The studio tab stops responding | Reload the tab (`Cmd+R` on macOS, `Ctrl+R` elsewhere). Your project autosaves in the browser. |
| MCP tools do not move the editor | See "One hub per port". |

## Privacy

The official npm package sends anonymous usage counts. It never sends project content.
Turn it off with `cclay telemetry off`, or with `COZYCLAY_TELEMETRY=0` or `DO_NOT_TRACK=1`.
Details: [`docs/privacy.md`](docs/privacy.md).
