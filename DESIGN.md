# CozyClay Studio Design Contract

## 0. Research Log

- Existing product surface: preserved the current dark Unity-like editor,
  compact timeline controls, violet camera identity, and bilingual labels.
- Interaction reference: the destructive action uses the existing immediate
  editor-button mechanism; no modal or animation is introduced because rail
  geometry is reversible by drawing it again and the state change is local.
- No new dependency, font, layout primitive, or motion token is required.

## 1. Direction

CozyClay is a dense production tool, not a dashboard. Controls stay compact,
technical, and close to the timeline state they change.

## 2. Color and surface tokens

The v2 shell uses brightness steps to separate regions. Regions do not have
borders; the surface value does the work.

- **Surfaces:** gap/background `#070708`; bars `#121214`; panels `#151517`;
  raised/hover `#1e1e21`; active control `#26262a`; fields `#0f0f11`;
  deep field `#0c0c0d`; in-panel divider `#1d1d20` (list rows only);
  viewport overlay pill `rgba(12,12,13,.78)`.
- **Text:** primary `#e4e4e7`, secondary `#9b9ba1`, tertiary `#636369`;
  list rows `#c9c9ce`, disabled/ticks `#4f4f55`, selected title `#fff`.
- **Accents:** selection and active controls use amber `#e8a33d`, with the
  selected-row tint `rgba(232,163,61,.14)` and text on amber `#1a1204`.
  Camera marks, rails, dots, buttons and primary actions use violet
  `#7258a0` or its light mark value `#a78bfa`.
- **Functional colours:** destructive `#e5484d`; axes X `#e5484d`, Y
  `#4fbf7a`, Z `#4c8dff`; status ok `#4fbf7a`; dirty dot `#e8a33d`.
- **Track chips:** folder `#8a7a55`, mesh `#7e8b99`, cast `#5fb584`, camera
  `#a78bfa`, light `#d9b84a`, motion `#6f93d6`.
- **Sequencer fills:** camera `#3d3354` / `#302a40`; body `#23402f`; selected
  body `#2e5a3f`; prompt `#233149` with text `#b9c9ea`.

## 3. Type, spacing, and region sizes

- IBM Plex Sans is used at 400/500/600 weights. UI text is 12 px, secondary
  text is 11–11.5 px, and titles are 15 px at 600 weight.
- JetBrains Mono is used at 400/500 for keys, numbers and frames, at 10–12 px.
  Fonts are self-hosted woff2 assets; the shell does not load a CDN font.
- Controls are 28 px or 24 px high. Control corners are 4 px; pills and cards
  use 6 px. The spacing scale is 8 / 12 / 16 px.
- The 2a shell record (an earlier version; §6 supersedes its layout and
  sizes) is 1920×1080: top bar 44 px, right column 340 px, bottom dock
  330 px, status bar 24 px. Panel headers are 36 px, Outliner rows 24 px,
  Sequencer rows 38 px with a 190 px track tree, and Content is 620 px wide.
- **Top bar (`#121214`):** a 20 px project swatch, project name and dirty dot,
  and File/Edit/Window/Help menus. The 2a version also showed MCP status and
  a violet Generate Motion action; today the MCP status element is hidden and
  there is no Generate Motion action.
- **Viewport:** a `+ Add` pill and Perspective / Clay Lit / Show pill at top
  left; the single mode+tool pill at top centre; fly speed at top right; axis
  gizmo at bottom left; and a 300 px camera preview with a 26 px header and
  letterbox bars at bottom right.
- **Right column:** Outliner is 420 px tall with a 36 px header, 28 px search,
  and 24 px tree rows. Details is selection-driven with a 15/600 name, an 11 px
  type line, a 64 px transform label plus X/Y/Z fields, and 24 px category rows.
- **Bottom dock:** Content is 620 px wide with Content / Log tabs, breadcrumb,
  160 px search, a 140 px folder list and a six-column asset grid. The selected
  asset has a 1.5 px amber ring. Sequencer fills the remaining width.
- **Status bar:** 24 px high, JetBrains Mono 10.5 px; status text is on the
  left and fps plus save state are on the right.

## 4. Motion and Interaction


- Camera toolbar actions respond immediately.
- Crane editing exposes explicit Add point and Remove point actions beside the
  selected point height and count. Add point fills the largest un-authored
  interval and selects the new mark; Remove point is enabled only for a
  selected interior mark. The scene double-click/Delete gestures remain
  accelerators, never the only discoverable route.
- When a Shot uses Rail + Crane, its lower key strip represents crane progress:
  clicking the strip authors a crane point at that rail position, and the
  matching purple/amber marker stays synchronized with the scene handle.
- Binary camera actions state themselves in text (`Follow On` / `Follow Off`)
  and expose `aria-pressed`; Follow sits directly beside `Draw rail` and uses
  the existing violet Camera Block active state.
- Active drawing state continues to use the existing filled violet state.
- Destructive rail deletion uses a red hover/focus cue and an explicit text
  label; no icon-only or right-click-only deletion.
- Keyboard focus must remain visible.
- Full-Body editing is direct and frame-addressed: `Cut` splits at the
  playhead, while each resulting green segment owns a compact speed selector.
  Speed changes redraw the segment width immediately; there is no decorative
  transition because the new duration is the information.
- Full-Body speed runs from `0.1×` to `4.0×` in `0.1×` steps. The current
  segment is identified by the playhead and receives the brighter green
  selected state. Its slider and numeric stepper stay in the fixed timeline
  header instead of inside the segment, so a one-frame segment remains
  editable. Outer trim handles continue to own only the complete take's
  in/out points.

## 5. v2 shell gap fills and reusable primitives

The following gap fills are part of the v2 contract. They describe the
missing behaviour in the same grammar as the owner's 2a, 2b and 2c screens.

### G1 — mode and tool toolbar

One 32 px pill sits at the viewport top centre in this order: mode keys `1 2 3
4 5`, divider, tool keys, divider, context values. The active mode shows its
amber mono digit and its name (Stage / Pose / Camera / Motion / Sculpt; in
Korean, 배치 / 포즈 / 카메라 / 모션 / 조형); inactive modes show only a 28×28
digit. A storyboard project has no Motion key (`1 2 3 5`). W/E/R
keys are 28×28, with the active tool filled amber `#e8a33d` and text
`#1a1204`; inactive tools use `#9b9ba1`. Every key has a title with its full
name and shortcut.

- Stage: W Move, E Rotate, R Scale; values `5cm` and `5°` (snap toggles on
  click and Ctrl inverts it).
- Pose: W Pose fix (IK parts), E Auto Pose, R Pin (range pin; refused until a
  motion take exists); no value group.
- Camera: W Move, E Rotate; values `24mm` and `2.39` (each opens a small list).
- Motion: no tools and no value group; the agent compiles motion.
- Sculpt: W Front, E Side, R Back views (with a part selected they move,
  rotate and scale it); no value group.

Keys 1–5 switch modes and W/E/R select tools only when focus is outside a text
field.

### G2 — mode to state mapping

Stage keeps `workflowMode "scene"` for the bus and saved views. Pose uses the
new `workflowMode "pose"`; entering it runs `toggleIkMode` and leaving it runs
`leaveIkMode`. Without a character with IK chains, key 2 is disabled and its
title explains why. Camera, Motion and Sculpt use `"camera"`, `"motion"` and
`"sculpt"`, and `view.setMode` accepts `"pose"`.

### G3 — Pose Details

For a selected character or rig group, Details lists Pose (Foot lock, Body
contact, influence range), then the selected tool section. Auto Pose contains
the model state (loading percentage, ready, could not load with Try again, or
not on this site in a build without the model), one hint line, the whole-pose
actions (Back to T-pose, Flip left and right, Copy pose, Paste pose, Paste
reversed) and a chip per handle; the selected handle shows On, Hold position,
Hold rotation and the Tolerance and Turn tolerance sliders as 24 px rows. In
the viewport its handles follow the IK handles' colours: held is a solid dot
with a thick ring and an outer ring, following is a solid dot with a thin ring,
off is a faint hollow ring, turn-only handles are diamonds, and the selected
handle gets a white ring plus X/Y/Z turn rings. Pin contains the range-pin
controls as 24 px rows.

### G4 — auto-fix preview and apply

Removed in 3.0.

### G5 — Sequencer

The 36 px header has the title, 26×24 transport, amber mono frame readout
`0092`, `/ 0240 · 24fps`, and mode-specific 24 px buttons: Stage/Camera Cut,
Draw rail, + Track; Motion Cut, + Block; Pose Cut. Tracks group each character
(Prompt, Body, Pins, IK keys) and camera (Camera Cuts, Rail, Crane). The playhead
is amber, pin ranges are amber at 35% alpha, and existing Cut, speed, trim and
crane editing continue to work.

### G6 — Motion takes

Removed in 3.0.

### G7 — export and save

The File menu contains New, Open…, Save `⌘S`, Save As…, then Export ▸ with
Keyframe pack (zip) `⌘E` first, Video (mp4), Depth + normal, Storyboard (PNG),
and OTIO cut list only when a shot exists. Existing ids stay on the moved
controls: `topbar-save`, `topbar-export`, `export-keyframe-pack`,
`export-video`, `export-otio`, `export-menu-trigger`. Save state remains
`data-testid="project-save-status"` in the 24 px status bar (`Autosaved 2 min
ago` / `Unsaved changes`); export progress, retry and cancel use
`export-status` there and in Log.

### G8 — menus and Show

Edit contains Undo, Redo and Preferences… (2c); Window contains Agent, Content
and Log; Help contains Tutorial, Keyboard shortcuts and About. Show is the
viewport's Reference grid, Auto Color, Body part colours and Trails menu. Clay
Lit is the shading list; Perspective is the camera/view list. Language moves
to Preferences (General › Appearance). UI copy contains no Kimodo, ProjFlow or
2D Root.

### G9 — Agent pane

The Agent always sits at the foot of the right column (#570), under Details;
it no longer replaces Details. Collapsed it is a 44 px bar (the default);
Window › Agent, Cmd/Ctrl+B, the bar and the chevron in its header fold it
open and shut. Open, a 12 px handle above it resizes the split.

### G10 — adding things

There are exactly two visible add routes. Viewport `+ Add` opens the object
catalogue plus Character and Camera. Content › Basic Shapes lists catalogue
primitives; drag to the viewport or double-click to place. The Outliner
right-click Create ▸ accelerator remains. The hierarchy `AddObjectMenu` and
Props inspector `AddObjectMenu` are removed.

### G11 — responsive shell

Superseded by §6 (#570): the bottom dock holds only the Sequencer and the shot
preview, `clamp(220px, 30vh, 300px)` tall by default, and every panel edge has
a drag handle.

### G12 — start and Preferences

Screen 2b replaces the project browser/startup chooser with today's samples;
without samples it shows only Blank Stage. Screen 2c is a modal Preferences
dialog whose navigation has one General group: Appearance, Viewport, Export
and Hotkeys (a read-only list).

### Reusable primitives

- `.tl-camera-tool`: compact camera-toolbar action.
- `.tl-camera-tool.active`: active/engaged action.
- `.tl-camera-tool.danger`: destructive camera-toolbar action.
- `.tl-camera-metric`: read-only measured camera value.
- `.tl-motion-clip`: one cut Full-Body segment.
- `.tl-motion-clip.selected`: segment under the playhead.
- `.tl-motion-speed-editor`: fixed header slider and numeric stepper for the
  Full-Body segment under the playhead.
- `.tl-crane-editor`: card-local time/height graph; the graph inserts points,
  points have enlarged targets, and vertical drags edit height without moving
  the Shot block.

## 6. Floating-glass shell and themes (#570)

The viewport fills the window. Every other region floats over it as a glass
panel with 12 px gutters and a 20 px radius:

- **Left column (260 px):** the project name with its save state as the
  panel's title, then the Outliner, then the object Library (Content | Log).
  Outliner rows are 30 px with a 16 px line icon per type; the selected row is
  a filled accent row. The Library picks its folder from a dropdown and draws
  objects as line glyphs in a 3-column grid of 12 px-radius tiles.
- **Right column (300 px):** Details and the Agent as two separate cards with
  a 12 px gap (G9). Details is titled by the selection (name, then kind); each
  section is an 11 px label over a rounded card.
- **Top row:** menus left, the mode switch (Stage, Pose, Camera, Motion, each
  with its icon) centred. All 40 px capsules between the two columns. (The
  #570 version ended the row with one capsule for the MCP state and Generate
  Motion; the MCP state is now hidden and Generate Motion is removed.)
- **Viewport rails:** a 44 px vertical rail on the left (Add, the mode's tools,
  its value such as snap) and one on the right (view, shading, Show, fly
  speed). Rail controls are 36 px round buttons with 16 px line icons; their
  menus open beside the rail.
- **Bottom dock:** the Sequencer (48 px head: transport capsule, frame count,
  actions; 26 px rows, 170 px track column, no lane grid) and the Shot Camera
  card at its right end (340 px): title and lens, the frame, a ratio switch
  (16:9, 2.39, 4:3, 1:1, 9:16) and Look through. The dock's glass is masked
  over the frame, because the shot camera is drawn into the stage canvas
  beneath it.
- **Status line:** the dock's own 28 px bottom row (status, fps, source link),
  separated by a hairline rather than floating on its own.
- **Top-View:** hidden until something is drawn on it — a camera rail, an
  object path or root waypoints — then it opens under the overlay row.

Every panel boundary resizes from its gutter: left width (200–30 % of the
window), right width (280–50 %), dock height, Outliner/Library split,
Details/Agent split and Sequencer/shot-preview split (240–560 px). Sizes
persist with the workspace layout.

Themes live on `<html data-theme>` (Preferences › Appearance › Theme) and are
declared in `src/styles/themes.css` (shell layer, so they outrank `tokens.css`
and the legacy `:root` aliases):

- **Dark (default):** the v2 surfaces in §2 with a deep clay-orange accent
  (`--select #b8541d`, tint `rgba(184,84,29,.18)`, tinted text `#e08a55`,
  white text on the accent). Panels carry a soft top light and a darker bottom
  edge; the accent bleeds 7 % into the top of each panel; primary buttons use
  a `#c8622a → #a84a17` fill. The stage itself gets no tint.
- **Light:** a `#eaeaed` window, translucent white glass (74 %, Details and
  Agent 82 % for reading), system blue accent (`--select #0a6ee0`, tint
  `rgba(0,122,255,.14)`), text `#1d1d1f / #6e6e73 / #86868b`.

Panel interiors are styled in `src/shell/glass-regions.css`, unlayered like
the Outliner, Sequencer and Details sheets it restyles and loaded after them.
Numbers use the UI font with tabular figures; the shell sets no monospace.

Both themes use the system UI font first (`-apple-system`, SF Pro), with IBM
Plex Sans and the Korean families as fallbacks. Hard-coded legacy colours in
`styles.css` and the Agent stylesheet read `--lg-*` / `--agent-*` variables
whose fallbacks are the original dark values, so only the light theme
overrides them.
