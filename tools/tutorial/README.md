# Tutorial recorder

Turns an episode script into a tutorial video that points at each feature: it drives the Studio (and an install terminal) over CDP, dims the page around the feature it names in a callout, shows chapter cards, screencasts it with a visible cursor, and burns captions in the `--locale` language into a band under the frame. No voice unless asked.

```
episode (flat steps | chapters) -> record.mjs -> steps.mjs (input, overlay.mjs, terminal.mjs, Studio)
  -> assemble.mjs (capture) -> captions.mjs (PNG per cue) -> mux.mjs (band + captions [+ voice]) -> mp4, chapter cuts
```

| Episode shape | Output |
| --- | --- |
| flat array of steps | `dist/tutorial/<episode>.mp4` (`<episode>-ko.mp4`), `.ko.srt`, `.en.srt` |
| `{ title, subtitle, chapters: [{ id, title, steps }] }` | `dist/tutorial/<episode>/<episode>.<locale>.mp4`, `<nn>-<chapter>.<locale>.mp4` per chapter, `<episode>.<locale>.srt` |

## Run

```sh
npm run tutorial:record -- stub-tour --locale ko
npm run tutorial:record -- first-video --size 1920x1080
```

`launch.mjs` starts `tools/dev-full.mjs` (the Agent panel needs the agent server) with an empty config dir and no provider keys or endpoints from your shell, so the panel shows the "Connect a model" card on any machine. It runs `record.mjs` inside `tools/qa-browser.mjs` and stops both. Ports: `TUTORIAL_DEV_PORT` (5594), `CDP_PORT` (5595), `COZYCLAY_LIVE_PORT` (5596), `COZYCLAY_OAUTH_PORT` (5597).

Against a dev server you already run:

```sh
QA_URL=http://127.0.0.1:5594/app/ CDP_PORT=5595 node tools/qa-browser.mjs -- node tools/tutorial/record.mjs first-video
```

Opening the Studio clears the origin's storage first (`Storage.clearDataForOrigin`), so the Studio makes a first open (straight to the editor), and the recorder then opens the project chooser with the name field through File > New. The Agent pane starts folded in a recording (the Studio opens with it unfolded): the episodes point at its bar and open it with Cmd/Ctrl+B. Downloads from an export step go to a scratch dir. One continuous capture is cut into the chapter files, so chapters join without a seam.

Flags: `--locale en|ko` (UI and caption language), `--size 1600x1000|1920x1080`, `--voice off|say` (default off), `--wps-ko 1.6` and `--wps-en 2.5` (reading speed), `--fps 30`, `--out dist/tutorial`. `npm run build` empties `dist/`.

## Captions and optional voice

A cue without a clip lasts max(its actions, 1.2 s + its words at the video language's reading speed). With `--voice say`, voice runs before recording, because each cue then lasts its clip plus 0.4 s. Per narrated step, in order:

1. Your recording: `tools/tutorial/voice/<episode>/<step-id>.<ko|en>.<wav|m4a|mp3|aiff>` (ignored by git). Use the srt as the script.
2. macOS `say` (ko Yuna, en Samantha). A step's `speech: { ko, en }` changes what is read, not the caption.
3. Neither: the cue is silent and holds for its word count at `--wps-ko`/`--wps-en`.

Captions are PNGs drawn by the recording Chrome and laid with ffmpeg `overlay` in a band added under the frame (13% of its height), so they never cover the UI. ffmpeg needs `libx264` and `aac`; libass is not required. Korean captions need a Korean font (macOS has one; on Linux install `fonts-noto-cjk`). The mux stops if a clip is longer than its cue.

Requires ffmpeg on `PATH` or in `FFMPEG`; the recorder stops with one line if it is missing.

## Episodes

One file per episode in `episodes/`: a `.mjs` default export or a `.json` array of steps.

```js
{ id: "select", narration: { en: "...", ko: "..." }, click: "[data-node-id=characterA]", until: ".selected" }
```

Each step has exactly one action:

| Action | Value |
| --- | --- |
| `click` | selector, or a list clicked in order |
| `type` | text for the focused element, or `{ into: selector, text }` (clicks the field and replaces its value) |
| `key` | chord such as `Mod+B` or `Space` (`Mod` is Cmd on macOS, Ctrl elsewhere); a focused button is blurred first |
| `drag` | `{ from: selector or { js: expression giving { x, y } }, to: selector or { dx, dy } }` |
| `wait` | selector, or milliseconds |
| `hold` | milliseconds |
| `eval` | page expression, awaited; a result with `ok: false` stops the run |

| `spotlight` | selector, with `label: { ko, en }` and optional `note`; dims the page around the element (rect read at that moment, so open menus work) and names it; `null` clears |
| `menu` | `{ open, then }`: click `open`, then click `then`, leaving the menu open for a spotlight |
| `card` | `"opening"` (episode title), `"closing"` (lists the titled chapters) or `{ title, subtitle }` (numbered by its chapter) |
| `terminal` | `{ typed, lines }`: `scenes/terminal.html` types the command and prints the lines |
| `studio` | `true`: open the Studio and its project chooser (an episode without it starts there) |

A spotlight holds for 1.2 s + its label and note at reading speed, a card for at least 2 s, a terminal for 1.5 s after its last line; `hold` beside them overrides that.

`until` (optional) waits for a selector after the action. A step without narration runs inside the cue of the narrated step before it; a chapter end closes the cue. The srt entry and caption span exactly the cue. `test/verify-tutorial-recorder.mjs` validates every rule above.
