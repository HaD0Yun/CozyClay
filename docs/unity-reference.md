# Unity Editor scene-authoring interaction model — reference for CozyClay

This document records how the Unity Editor actually behaves when you place and manipulate objects in the Scene view, and then says — rule by rule — what CozyClay should do with each rule. It is a specification, not an implementation plan: no code, no file layout, no API shapes.

Every behavioural claim carries the URL of the page it came from. Claims that are **not** in the official manual are marked `[community]` or `[observed]` and should be treated as weaker evidence.

Unity version of record: **Unity 6.5 (6000.5) manual**, read 2026-08-09. Two of the originally requested URLs no longer exist:

- `Manual/UnityHotkeys.html` now redirects to <https://docs.unity3d.com/Manual/ShortcutsManager.html>. Unity removed the static hotkey tables in 2019.1 (stated on the legacy page <https://docs.unity3d.com/2021.3/Documentation/Manual/UnityHotkeys.html>); the defaults now live on the individual feature pages, which is where the keys below are cited from.
- `Manual/EditingValueProperties.html` 404s on the current docs. The last official version of that page is <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html> and is used here for the numeric-field behaviour.

**CozyClay context assumed by this document** (verified in the repository when this document was written, not taken on trust). These bullets describe that earlier version, which the "Replaces" columns below refer to; the code has moved on since:

- `src/controls.jsx` — `FlyControls`: pointer-down with `button === 0` starts a look-drag; the wheel dollies along the lens axis; W/A/S/D walk at 2.6 m/s; Q/E crane at 1.3 m/s; pitch is clamped at 85°. The rig is live whenever the viewport is.
- `src/object-gizmo.jsx` — one gizmo with three modes; three axis arrows, three world-axis rings, three axis boxes plus a centre box; handles are already drawn at constant screen size (`SCREEN_SCALE = 0.16`) with fat invisible pick proxies; the pointer-down listener also only accepts `button === 0`; the gizmo sits at the object's centre height.
- `src/scene-objects.js` — translation snaps to 0.05 m, rotation to 5°, scale to 0.05, always, with no modifier to defeat it; rotation and scale are stored per world axis (`rotX`/`rot`/`rotZ`, `scaleX`/`scaleY`/`scaleZ`), so there is no local space at all.
- `src/App.jsx` — `GIZMO_HOTKEYS = { KeyG: "move", KeyR: "rotate", KeyT: "scale" }`; Delete/Backspace removes the selected object; the "Object Transform" card is nine `Slider` widgets (Position X/Y/Z step 0.05, Rotate X/Y/Z step 1, Scale X/Y/Z step 0.05) plus a name field, colour swatches and a Remove button. Today `GIZMO_HOTKEYS` is `{ KeyW: "move", KeyE: "rotate", KeyR: "scale" }` in `src/stage-startup-defaults.js` (§9.2), the Delete/Backspace handler is still in `src/App.jsx`, and the nine-slider card is gone.
- `src/hierarchy-panel.jsx` — a static tree of rows plus an "Add object" popover; no context menu, no in-place rename, no duplicate.

---

## 1. Mouse bindings in the Scene view

This is the section that matters most, so read the shape of it before the details: **in Unity the left button belongs to the content and the right button belongs to the camera.** Left-click selects, left-drag on empty space draws a marquee, left-drag on a gizmo handle transforms. Camera flythrough is held on the *right* button, and W/A/S/D/Q/E only mean "move the camera" while that right button is down. Outside of a right-button hold those keys are tool hotkeys, not movement keys. Unity never spends an unmodified left-drag on looking around.

| Input | Modifier | Result | Source |
| --- | --- | --- | --- |
| Left-click on a GameObject | — | Selects that GameObject. Repeated clicks in the shared space of overlapping GameObjects cycle the selection between them. | <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Left-click on a GameObject | **Shift**, or **Ctrl** (macOS **Cmd**) | Adds to / removes from the selection. Shift-clicking an already-selected object also changes which object is the "active" one (the pivot source in Pivot mode). | <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Left-drag on empty space | — | Rubber-band (marquee) selection: everything inside the rectangle is selected. | <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Left-click on empty space | — | Clears the selection. `[observed]` — the manual documents marquee and click-to-select but does not state the empty-space case explicitly. | — |
| Left-drag on a gizmo handle | — | Runs that handle's transform (move / rotate / scale). The dragged axis turns yellow and stays selected after mouse-up. | <https://docs.unity3d.com/Manual/class-Transform.html> |
| Left-drag on a gizmo handle | **Ctrl** (macOS **Cmd**) | Same transform, snapped to the increment snap values. | <https://docs.unity3d.com/Manual/SnapIncrements.html> |
| Left-drag on the Move gizmo centre | **Shift** | The centre becomes a flat square and the object moves on a plane parallel to the Scene camera (screen-space move). | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| Left-drag on a Move handle | **Shift+Ctrl** (macOS **Shift+Cmd**) | Surface snapping: the object snaps to the intersection of another object's Collider under the cursor. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| Left-drag from a vertex | **V** held | Vertex snapping: the grabbed vertex is the pivot and snaps to vertices on other meshes. Add **Shift+Ctrl** / **Shift+Cmd** to snap that vertex to a *surface*; add **Shift** alone to snap the *pivot* to a vertex. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| Left-drag | **Alt** (macOS **Option**) | Orbits the camera around the current pivot point. Not available in 2D/orthographic. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Left-drag | **Alt+Ctrl** (macOS **Option+Cmd**) | Pans the view (the 2-button-mouse / trackpad substitute for middle-drag). | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Left-drag | **Ctrl** on macOS, or **Option+Ctrl** on a one-button Mac | Zooms (dolly) — the macOS substitute for Alt+right-drag. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Left-drag with the View tool active (**Q**) | — | Pans the camera. This is the only state in which a bare left-drag moves the camera, and it is an explicit modal tool the user chose. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **Right-button held + mouse move** | — | **Flythrough mode.** The view looks around in first person while the button is held. Perspective only: in orthographic mode the same gesture orbits, in 2D mode it pans. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Right-button held, then **W/S** | — | Live only during flythrough: move forward / backward. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Right-button held, then **A/D** | — | Live only during flythrough: move left / right. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Right-button held, then **Q/E** | — | Live only during flythrough: move down / up. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Right-button held, then **Shift** | — | Live only during flythrough: move faster. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Right-button held, then **wheel** (or two-finger drag) | — | Changes the flythrough movement speed — it does **not** dolly. Outside flythrough the wheel zooms. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Right-click (press and release without dragging) | — | Opens the Scene view context menu for the current selection: cut / copy / paste / delete / duplicate, view options, Isolate, Add Component, Properties, the Prefab menu, the Transform menu and the Grid menu. | <https://docs.unity3d.com/Manual/SceneViewContextMenu.html> |
| Right-click | **Ctrl** (macOS **Cmd**) | Opens the *selection piercing menu*: a list of every GameObject under the cursor in screen space, so you can pick the one you want instead of cycling. | <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html> |
| Right-click | **Ctrl+Shift** (macOS **Cmd+Shift**) | Same piercing menu, but the chosen object is *added* to the existing selection. | <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html> |
| Right-drag | **Alt** (macOS **Option**) | Zooms the view. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Middle-drag | — | Pans the camera. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Wheel | — | Zooms (dollies) the Scene camera. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Wheel / any navigation drag | **Shift** | Increases the rate of movement and zooming. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Two-finger trackpad drag | — | Zooms. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| Three-finger trackpad swipe (macOS) | — | Snaps the camera to the axis direction of the Orientation overlay arm you swiped toward. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |

Two structural points worth naming explicitly, because they are the design that makes the rest work:

1. **The right button carries two meanings, disambiguated by movement.** A right press that releases without moving opens the context menu (<https://docs.unity3d.com/Manual/SceneViewContextMenu.html>); a right press that moves enters flythrough (<https://docs.unity3d.com/Manual/SceneViewNavigation.html>). Unity does not ask the user to choose a mode.
2. **Every camera gesture on the left button is behind a modifier or behind the explicit View tool.** Nothing the user does with a bare left button moves the camera. That is why left-click-to-select and left-drag-to-marquee can exist at all.

---

## 2. Keyboard

Unity's hotkeys are all reassignable through the Shortcuts Manager (**Edit > Shortcuts**, macOS **Unity > Shortcuts**) — <https://docs.unity3d.com/Manual/ShortcutsManager.html>. The defaults below are the ones that matter for placing objects.

| Key | Action | Source |
| --- | --- | --- |
| **Q** | View tool (hand). Left-drag pans; Alt+left-drag orbits; Alt+right-drag zooms. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **W** | Move tool. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **E** | Rotate tool. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **R** | Scale tool. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **T** | RectTransform tool. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **Y** | Transform tool (combined move + rotate, plus scale when the handle rotation is Local). | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **F** | Frame Selected: centres the Scene view on the selection. If the object is already framed, F zooms in to the pivot point. Also **Edit > Frame Selected**. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **Shift+F** | Lock View to Selected — the view keeps following the object as it moves. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **Arrow keys** | Walk the camera: Up/Down move forward/backward along the view direction, Left/Right pan sideways. **Shift** + arrow moves faster. Available without holding any mouse button. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **W / A / S / D / Q / E** | Camera movement — **only** while the right mouse button is held (flythrough). | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **Shift** (during flythrough) | Move faster. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |
| **Ctrl** (macOS **Cmd**) held during a gizmo drag | Transform in increment-snap steps. | <https://docs.unity3d.com/Manual/SnapIncrements.html> |
| **V** held | Vertex snapping while dragging with the Move tool. **Shift+V** toggles it instead of holding. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **Shift+Ctrl** (macOS **Shift+Cmd**) held during a Move drag | Surface snapping onto a Collider. Held during a Rotate handle drag it is look-at rotation toward a point on a collider. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **Shift** held while using the Transform tool (Y) | Screen Space mode: move, rotate and scale as the object appears on screen. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| **Ctrl+D** (macOS **Cmd+D**) | Duplicate the selected GameObject. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| **Ctrl+Shift+N** (macOS **Cmd+Shift+N**) | Create a new empty GameObject. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| **Ctrl+Shift+G** (macOS **Cmd+Shift+G**) | Create Empty Parent around the selection. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| **Ctrl+Shift+V** (macOS **Cmd+Shift+V**) | Paste as Child. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| **\\** | Toggle grid snapping on/off. | <https://docs.unity3d.com/Manual/GridShortcuts.html> |
| **Ctrl+\\** (macOS **Cmd+\\**) | Push To Grid — move the selected object to the nearest grid point. | <https://docs.unity3d.com/Manual/GridShortcuts.html> |
| **Ctrl+[** / **Ctrl+]** (macOS **Cmd+[** / **Cmd+]**) | Decrease / increase grid size. | <https://docs.unity3d.com/Manual/GridShortcuts.html> |
| **Ctrl+/**, **Ctrl+;**, **Ctrl+'**, **Ctrl+Shift+;**, **Ctrl+Shift+'**, **Ctrl+Shift+\\**, **Ctrl+Shift+/** (macOS: Cmd equivalents) | Reset grid to world; move grid to handle position; move grid to active object; align grid to handle rotation; align grid to object rotation; align object to grid; apply last custom grid values. | <https://docs.unity3d.com/Manual/GridShortcuts.html> |
| **H** / **L** (multi-selection, Hierarchy) | Toggle Scene visibility / Scene pickability. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| **`** (backtick) | Open the Overlays menu (Tools, Tool Settings, Grid and Snap, View Options…). | <https://docs.unity3d.com/Manual/overlays.html> |
| **Delete** | Deletes the selection. Present in the Scene view context menu as a clipboard action; the key itself is not spelled out in the manual. `[observed]` | <https://docs.unity3d.com/Manual/SceneViewContextMenu.html> |
| **F2** (Windows) / **Return** (macOS) | Rename the selected item in place. `[community]` — not in the manual; the manual only says new GameObjects open in rename mode by default. | <https://discussions.unity.com/t/keyboard-shortcut-to-rename-gameobject/109770/2>, and <https://docs.unity3d.com/Manual/Hierarchy.html> for the rename-mode default |
| **Escape** | Not documented in the manual as a Scene view command. In practice it dismisses menus and popovers. `[observed]` | — |

---

## 3. Gizmo anatomy, per tool

### 3.1 Conventions shared by all three gizmos

- **Axis colours are fixed and mean the axis, not the tool**: x = red, y = green, z = blue (<https://docs.unity3d.com/Manual/class-Transform.html>). The same colours are used in the Inspector's Transform rows.
- **The handle under an active drag turns yellow**, and stays selected after the mouse is released (<https://docs.unity3d.com/Manual/class-Transform.html>, <https://docs.unity3d.com/Manual/PositioningGameObjects.html>).
- **Handles are drawn at constant screen size.** Unity computes handle size from the distance between the handle position and the camera, precisely so that a handle occupies the same number of pixels regardless of depth (<https://docs.unity3d.com/ScriptReference/HandleUtility.GetHandleSize.html>).
- **The gizmo sits where the handle-position toggles say it sits** — at the Transform's pivot, or at the centre of the selection bounds; see §4 (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).
- **Gizmos that get very small on screen fade out** rather than becoming unclickable noise ("Fade Gizmos", <https://docs.unity3d.com/Manual/GizmosMenu.html>).
- **The selection itself is drawn, not just the gizmo**: selected objects get an outline (orange by default) and their children a different outline (blue by default); an optional wireframe overlay is available. Both are toggles in the Gizmos menu (<https://docs.unity3d.com/Manual/GizmosMenu.html>, <https://docs.unity3d.com/Manual/SelectGameObjects.html>).

### 3.2 Move (W)

| Handle | Shape | What a drag does | Source |
| --- | --- | --- | --- |
| Three axis handles | Arrow (shaft + cone tip) in red/green/blue | Translates along that one axis only. | <https://docs.unity3d.com/Manual/class-Transform.html> |
| Three plane handles | Three small coloured squares clustered near the centre, in the quadrant between two axes | Translates in that plane — two axes change, the third is locked. The square's colour names the axis that is **locked**: the blue square locks z, so the object slides in the xy plane. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/class-Transform.html> |
| Centre, with **Shift** held | The centre changes into a flat square | Free-moves the object on a plane parallel to the Scene camera. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |

Note what is *absent*: there is no "grab the object's body and it slides" behaviour. Dragging the mesh itself with the Move tool active does not move the object in Unity; only handles move things. That separation is what makes click-to-select safe.

### 3.3 Rotate (E)

| Handle | Shape | What a drag does | Source |
| --- | --- | --- | --- |
| Three axis rings | The red, green and blue circles of a wireframe sphere around the object | Rotates about the matching x/y/z axis. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| Outermost circle | A larger circle enclosing the sphere, drawn flat to the viewer | Rotates about the Scene view's own z-axis — i.e. rotation in screen space. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| Any ring + **Shift+Ctrl** / **Shift+Cmd** | — | Look-at rotation: the object turns to face the point on a collider surface under the cursor. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |

The rotate gizmo is a *sphere*, not three disconnected rings: the rings read as great circles on one ball, which is what tells the user they all rotate the same object about the same centre. As with Move, the last-changed axis is coloured yellow (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).

### 3.4 Scale (R)

| Handle | Shape | What a drag does | Source |
| --- | --- | --- | --- |
| Three axis handles | A line ending in a small cube, red/green/blue | Scales that one axis. The manual warns to be careful with per-axis scale when the object has children, because the result can look strange. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |
| Centre knob | A cube at the gizmo centre | Uniform scale — rescales all three axes together. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |

There is no scale-plane handle in Unity's Scale gizmo.

### 3.5 The other two tools, for completeness

- **RectTransform (T)** combines move/scale/rotate in a rectangle: drag inside to move, drag an edge to scale one axis, drag a corner to scale two, hover just outside a corner (the cursor becomes a rotation icon) and drag to rotate (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>). It is a 2D/UI tool.
- **Transform (Y)** is the combined gizmo: move + rotate handles always, plus scale handles when the handle rotation is Local. Holding **Shift** puts it in Screen Space mode (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).

---

## 4. Handle and tool state

Both toggles live in the **Tool Settings** overlay and apply to every transform tool (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).

### 4.1 Position of the gizmo: Pivot vs Center

| Setting | Where the gizmo is drawn | Consequence for a drag | Source |
| --- | --- | --- | --- |
| **Pivot** | At the GameObject's actual pivot point as defined by its Transform | Rotation and scale happen about the authored pivot — a door rotates about its hinge. With several objects selected, the "active" object (by default the last one selected) supplies the pivot. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| **Center** | At the centre of the selected GameObjects' combined bounds | Rotation and scale happen about the visual centre of the selection — a group of props rotates as one cluster. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> |

### 4.2 Orientation of the handles: Local vs Global vs Grid

| Setting | What the gizmo draws | What a drag means | Source |
| --- | --- | --- | --- |
| **Local** | Axes aligned to the GameObject's own rotation | "Forward" means the object's forward. The Transform tool (Y) only shows scale handles in this mode. Absolute grid snapping does not apply; snapping falls back to incremental. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html> |
| **Global** | Axes clamped to world space | "Forward" means world +z regardless of how the object is turned. Required (with Grid) for absolute grid snapping. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/GridSnap.html> |
| **Grid** | Axes clamped to the grid's rotation | Lets you author along a rotated grid (angled corridors, bridges) while still snapping absolutely. | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/CustomizeGrid.html> |

The important coupling: **snapping mode depends on handle orientation.** Absolute grid snapping is only available in Global or Grid orientation; in Local orientation snapping is incremental even when absolute snapping is switched on (<https://docs.unity3d.com/Manual/GridSnap.html>, <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html>).

---

## 5. Snapping

Unity has three distinct snapping systems (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).

### 5.1 Grid snapping (absolute)

Move-tool only. Enable **Toggle absolute Grid snapping** in the Grid and Snap overlay, with the handle orientation set to Global or Grid; the object then snaps onto grid positions along the active gizmo axis (<https://docs.unity3d.com/Manual/GridSnap.html>). The grid defaults to a uniform size of 1 on all axes and can be resized per axis, repositioned and rotated (<https://docs.unity3d.com/Manual/CustomizeGrid.html>). `\\` toggles snapping; `Ctrl+\\` pushes the selection to the nearest grid point (<https://docs.unity3d.com/Manual/GridShortcuts.html>).

### 5.2 Incremental snapping (the modifier)

**Hold Ctrl (macOS Cmd) while dragging any transform gizmo to snap that drag to the increment values** (<https://docs.unity3d.com/Manual/SnapIncrements.html>). This is the single most important snapping rule for a blocking tool, and note its polarity: **snapping is opt-in per drag.** The unmodified drag is continuous.

The increments are configured separately per tool in the Grid and Snap overlay — **Incremental snapping size** for Move, **Incremental angle snap size** for Rotate, **Scale snap multiplier** for Scale — and each can be latched on permanently with its own toggle so the modifier is not needed (<https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html>, <https://docs.unity3d.com/Manual/SnapIncrements.html>).

Official default values: the grid is 1 unit on all axes (<https://docs.unity3d.com/Manual/CustomizeGrid.html>). The manual does not print the default rotate/scale increments. `[community]` walkthroughs of the default install show **15° for rotation** and integer-ish steps for scale, with the move increment differing between versions (<https://www.ketra-games.com/2020/08/unity-game-tutorial-increment-snap-and-grid-alignment.html>). Treat 1 unit / 15° as the well-attested pair and the scale default as unverified.

### 5.3 Surface and vertex snapping

- **Surface snapping**: with the Move tool active, hold **Shift+Ctrl** (macOS **Shift+Cmd**), grab the object's tool handle, and drag over another object — the object snaps to the intersection with that object's Collider (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).
- **Vertex snapping**: hold **V**, hover the vertex you want to use as the pivot, then drag it onto a vertex of another mesh. Add **Shift+Ctrl** / **Shift+Cmd** to snap that vertex to a surface, or **Shift** to snap the object's pivot to a vertex. **Shift+V** toggles the mode instead of holding it (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>).

Both are "grab a specific point on the object, not the object's origin" mechanisms. That idea — *the thing you grabbed is the thing that lands* — is the generalisable rule even when colliders and vertices are not part of the product.

---

## 6. Selection semantics

| Situation | Unity's behaviour | Source |
| --- | --- | --- |
| Click an object | It becomes the selection; outline turns orange, children blue. | <https://docs.unity3d.com/Manual/SelectGameObjects.html>, <https://docs.unity3d.com/Manual/GizmosMenu.html> |
| Click again in the shared space of overlapping objects | Selection cycles through the overlapping candidates, one per click. | <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Overlap resolution without guessing | **Ctrl+right-click** (macOS **Cmd+right-click**) opens the selection piercing menu listing every object under the cursor; pick one by name. **Ctrl+Shift+right-click** adds the picked object to the selection instead. | <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html> |
| Objects you never want to hit | Mark them un-pickable from the Hierarchy (hand icon) or the Scene picking controls; they stay visible but stop absorbing clicks. **L** toggles pickability for a multi-selection. | <https://docs.unity3d.com/Manual/ScenePicking.html>, <https://docs.unity3d.com/Manual/hierarchy-reference.html>, <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Drag on empty space | Marquee: everything inside the rectangle is selected. | <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Click empty space | Clears the selection. `[observed]` — not stated in the manual. | — |
| Shift-click / Ctrl-click (Cmd-click) | Adds or removes objects from the selection. Shift-clicking within an existing selection also re-designates the *active* object, which is the one that supplies the pivot in Pivot mode. | <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Click an object that is already selected | Nothing changes and nothing moves. Selection is idempotent; movement requires grabbing a handle. `[observed]` — the manual states only that handles perform transforms (<https://docs.unity3d.com/Manual/class-Transform.html>). | — |
| Select from the Hierarchy | Clicking the name in the Hierarchy selects the same object; the Scene view highlights it and the Inspector shows it. Selection is one shared state across Scene view, Hierarchy and Inspector. | <https://docs.unity3d.com/Manual/SelectGameObjects.html>, <https://docs.unity3d.com/Manual/Hierarchy.html>, <https://docs.unity3d.com/Manual/UsingTheInspector.html> |
| Find the selection in the viewport | **F** frames it; **Shift+F** locks the view to it. | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> |

---

## 7. Hierarchy panel

| Capability | Unity's behaviour | Source |
| --- | --- | --- |
| Create from the main menu | **GameObject > 3D Object >** Cube / Sphere / Capsule / Cylinder / Plane / Quad. The primitive is created with default size at unit scale. | <https://docs.unity3d.com/Manual/PrimitiveObjects.html> |
| Create from the panel | Right-click empty space under the scene row and pick the object type from the context menu. **Ctrl+Shift+N** (macOS **Cmd+Shift+N**) creates an empty GameObject. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| New objects open in rename mode | By default a newly created GameObject is immediately editable for renaming; the behaviour is switched off with **Rename New Objects** in the panel's ⋮ menu. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Rename later | Right-click > Rename, or **F2** on Windows / **Return** on macOS. `[community]` for the keys. | <https://docs.unity3d.com/Manual/Hierarchy.html>, <https://discussions.unity.com/t/keyboard-shortcut-to-rename-gameobject/109770/2> |
| Duplicate | Right-click > **Duplicate**, or **Ctrl+D** (macOS **Cmd+D**). | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Cut / Copy / Paste / Paste as Child | Right-click menu; **Ctrl+Shift+V** (macOS **Cmd+Shift+V**) pastes as child, and pasted children keep their world position. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Delete | Right-click > Delete (also available in the Scene view context menu's clipboard actions). | <https://docs.unity3d.com/Manual/Hierarchy.html>, <https://docs.unity3d.com/Manual/SceneViewContextMenu.html> |
| Reorder | Rows are listed in creation order, newest last, and can be dragged up or down. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Parent / unparent | Drag a row onto another to parent it; drag it elsewhere to unparent. **Create Empty Parent** (**Ctrl+Shift+G** / **Cmd+Shift+G**) wraps the selection in a new parent. | <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Per-row visibility and pickability | Eye icon hides/shows in the Scene view; hand icon blocks/allows picking. Icons appear on hover and have distinct "parent partially hidden / partially unpickable" states. **H** and **L** toggle them for a multi-selection. | <https://docs.unity3d.com/Manual/hierarchy-reference.html>, <https://docs.unity3d.com/Manual/Hierarchy.html> |
| Selection sync | Adding or removing an object in the Scene view adds or removes the row; selecting in either place selects in both. | <https://docs.unity3d.com/Manual/Hierarchy.html> |

---

## 8. Inspector Transform component

What Unity shows for a selected GameObject's Transform (<https://docs.unity3d.com/Manual/class-Transform.html>):

| Row | Fields | Notes |
| --- | --- | --- |
| **Position** | X, Y, Z on one line | World space if the object has no parent, otherwise relative to the parent. |
| **Rotation** | X, Y, Z on one line | Euler degrees about each axis. |
| **Scale** | X, Y, Z on one line, plus a **Constrained Proportions** toggle | 1 = imported size. Constrained Proportions (off by default) links the three axes so changing one changes all. |

The widget, exactly:

- **Three numeric fields per row**, colour-keyed to the axes (x red, y green, z blue) — <https://docs.unity3d.com/Manual/class-Transform.html>.
- **Type a value directly** into a field for precise adjustments — <https://docs.unity3d.com/Manual/class-Transform.html>.
- **Drag the field's label (or the field itself) up/down to scrub the value** for coarse adjustments. This is an unbounded relative drag with no end stops — <https://docs.unity3d.com/Manual/class-Transform.html>, <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html>.
- **Fields accept mathematical expressions**: `2+3` evaluates to 5; `*=2` doubles the current value; `L(a,b)` distributes a multi-selection linearly; `R(a,b)` randomises within a range — <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html>.

**Why sliders are wrong here, in Unity's own terms.** Unity's property documentation treats sliders as a distinct control used only for properties with a meaningful bounded range, and describes numeric properties as fields that you type into or drag-scrub (<https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html>). Transform values have no such range: position is unbounded, rotation wraps, and scale is a positive multiplier with no natural maximum. A slider imposes three costs a transform editor cannot pay — it invents min/max that do not exist, it quantises to the pixel width of the track so precision depends on panel width, and it makes exact values (`0`, `1`, `90`) hit-or-miss. Drag-to-scrub gives the same "nudge it and watch" affordance with unbounded range and pixel-independent precision, and typing gives exactness. That is why Unity's Transform has zero sliders.

---

## 9. Adaptation table

`Transfers` = adopt Unity's rule as written. `Adapt` = keep the intent, change the mechanics for CozyClay's single-viewport, no-parenting, no-collider, no-prefab reality. `N/A` = the rule depends on machinery CozyClay does not have.

### 9.1 Mouse bindings

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Bare left-drag never moves the camera; camera gestures are on the right/middle button or behind Alt | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Free the left button entirely. Left is for content: select, marquee, drag handles. | `src/controls.jsx` `onPointerDown` starting a look-drag on `button === 0`. This is the root conflict. |
| Flythrough is held on the **right** mouse button; releasing it ends flythrough | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Right-button-held + mouse move = look. Suppress the browser context menu on the viewport while doing so, and use pointer capture (pointer lock optional) so the drag survives leaving the canvas. | The always-on left-drag look in `FlyControls`. |
| W/A/S/D/Q/E move the camera **only while the right button is held**; Shift = faster | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Gate the existing walk/crane keys behind right-button-held. This frees W/E/R/T as tool hotkeys with no invention required. | `src/controls.jsx` treating W/A/S/D/Q/E as globally live. |
| Wheel zooms normally, but during flythrough it changes fly speed | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Keep the existing wheel dolly; while the right button is held, the wheel adjusts fly speed instead and shows the value. | `DOLLY_STEP` wheel handling being the wheel's only meaning. |
| Alt+left-drag orbits; middle-drag pans; Alt+right-drag zooms | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Adapt** | Add middle-drag pan and Alt+right-drag dolly — cheap and expected. Orbit is the one to think about: CozyClay is deliberately a camera-operator rig, not a turntable, so implement Alt+left-drag as *orbit around the selection* (falling back to a point in front of the camera when nothing is selected) rather than adopting Unity's pivot machinery. Document it as an intentional divergence. | Nothing — these are additions. Middle and Alt-modified buttons are currently unused. |
| Right-click without dragging opens a context menu; right-drag flies | <https://docs.unity3d.com/Manual/SceneViewContextMenu.html>, <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Disambiguate on movement: below a small pixel threshold and a short time budget, a right press/release opens the viewport context menu (Duplicate, Delete, Frame, Rename, Reset Transform); beyond it, it was a fly. | No viewport context menu exists today. |
| Ctrl/Cmd+right-click opens the selection piercing menu | <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html> | **Adapt** | Same gesture, listing every object the ray hits by name and kind. With a catalogue of blockout boxes that nest and overlap constantly, this is more valuable here than in Unity, not less. | Nothing — no overlap resolution exists today. |
| Trackpad: two-finger zoom | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Already effectively true via wheel events; make sure pinch/two-finger scroll maps to dolly and does not scroll the page. | — |
| Three-finger swipe snaps to an axis view | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **N/A** | Depends on the Orientation overlay and OS gesture settings; CozyClay has a fixed shot camera and a separate plan view. | — |

### 9.2 Keyboard

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| **W** = Move, **E** = Rotate, **R** = Scale | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Transfers** (once §9.1 frees the letters) | Rebind the three gizmo modes to W/E/R. Keep G/R/T as hidden aliases for one release so existing muscle memory does not break silently, and show the new keys on the mode buttons. | `GIZMO_HOTKEYS = { KeyG, KeyR, KeyT }` in `src/App.jsx` at the time (now W/E/R in `src/stage-startup-defaults.js`) and the `<kbd>G/R/T</kbd>` labels in the Object Transform card. Note the direct collision: today **R** means Rotate; in Unity **R** means Scale and **E** means Rotate. The migration must be announced in the UI, not silent. |
| **Q** = View tool (hand) | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Adapt** | Q is Unity's "stop editing, just navigate" tool. In CozyClay assign **Q** to a no-tool / pan mode where left-drag pans the camera. This is also the honest home for the Q key once craning moves behind the right-button hold. | Q as an always-live crane-down key. |
| **T** = RectTransform, **Y** = Transform (combined) | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **N/A** for T; **optional** for Y | RectTransform is a 2D/UI tool with no analogue here. A combined Y gizmo is a later nicety, not a v1 requirement. Leave T and Y unbound rather than reusing them for something else — reusing a Unity-reserved letter for a different meaning is what created the current mess. | T as Scale. |
| **F** frames the selection; pressing F again zooms to the pivot; **Shift+F** locks the view | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Transfers** | Implement F as "fly the shot camera to a framing distance from the selected object's bounds, keeping the current view direction". Shift+F keeps the camera tracking the object. F is the single highest-value key for a tool where the camera can walk away from the set. | Nothing — no framing command exists. |
| **Ctrl+D** / **Cmd+D** duplicates | <https://docs.unity3d.com/Manual/Hierarchy.html> | **Transfers** | Duplicate the selected object, select the copy, and offset it — Unity places the duplicate at the same transform; for blocking, an offset of one grid step along the camera-right axis is friendlier. Document the divergence. | Nothing — duplicate does not exist; users re-add from the catalogue and re-place by hand. |
| **Delete** deletes | <https://docs.unity3d.com/Manual/SceneViewContextMenu.html> `[observed]` for the key | **Transfers** | Keep Delete. Keep Backspace as an extra alias (harmless, and macOS laptops lack a real Delete). | Already implemented in the scene-object key handler in `src/App.jsx` (the Delete/Backspace branch that calls `deleteSelectedSceneObject`); no change beyond keeping it. |
| **F2** (Win) / **Return** (macOS) renames in place | `[community]` <https://discussions.unity.com/t/keyboard-shortcut-to-rename-gameobject/109770/2>; rename-on-create from <https://docs.unity3d.com/Manual/Hierarchy.html> | **Adapt** | Bind F2 **and** Return to "rename the selected hierarchy row in place". Also open a newly created object in rename mode, as Unity does. | The name-only text input buried in the Object Transform card, which is the only way to rename today. |
| **Escape** | not documented | **Adapt** — CozyClay's own rule | Escape should (1) cancel an in-progress gizmo drag and restore the pre-drag transform, (2) close any popover, and (3) with nothing else pending, clear the selection. Cancel-drag is the important one: CozyClay commits transforms as it drags. | Nothing — there is no way to abort a bad drag today. |
| **Ctrl+Z** / **Ctrl+Shift+Z** (macOS **Cmd+Z** / **Cmd+Shift+Z**) | Undo/redo exist as Editor commands, rebindable in the Shortcuts window; the manual does not define how many Scene-view operations one undo step spans | <https://docs.unity3d.com/Manual/ShortcutsManager.html> | **Adapt** — CozyClay's own contract | One *interaction* is exactly one undo entry: a drag, a field scrub, an inspector commit, a create/duplicate/delete, or a drop. A no-op records nothing (a redundant drop), and a scene load is never undoable. CozyClay rebinds redo to Ctrl/Cmd+Shift+Z — the browser's own redo convention. | Nothing — every edit was permanent. |
| **End** | Snap Actor to Floor — Unreal Editor's key, adopted as the trigger for CozyClay's drop | <https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-editor-hotkeys> | **Adapt** — CozyClay's own rule | End drops the selection straight down: its base lands exactly on the highest support top at or below it whose footprint overlaps, or on the floor. **Strict drop-down divergence from Unity's surface snapping:** Unity snaps *while dragging* onto a collider under the cursor (Shift+Ctrl / Shift+Cmd, §9.5) and that modifier form is deferred here; CozyClay's drop is one key press, the contact height is exact (never rounded to the 5 cm grid), x/z are never written, and a surface the object is already penetrating is NOT support — the object falls through, so recovery is raise Y above the box and press End again. The drop is idempotent (a second End changes nothing) and one undo entry. | Nothing — Y could only be typed or scrubbed, so objects floated or sank. |
| Arrow keys walk the camera | <https://docs.unity3d.com/Manual/SceneViewNavigation.html> | **Adapt** | Lower priority than the rest. If bound at all, bind arrows to nudge the *selected object* by one snap increment — for a blocking tool that is worth more than a second walk control, and it is a documented divergence rather than a conflict. | Nothing. |
| **`** opens the overlay menu; **\\** toggles snapping; Ctrl+[ / Ctrl+] resize the grid | <https://docs.unity3d.com/Manual/overlays.html>, <https://docs.unity3d.com/Manual/GridShortcuts.html> | **Adapt** | Take **\\** for "toggle always-on snapping" only if CozyClay keeps a persistent snap toggle (see §9.5). Skip the overlay and grid-resize keys; there is one viewport and one grid. | — |

### 9.3 Gizmo anatomy

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Move gizmo has three axis arrows **and three plane squares** | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/class-Transform.html> | **Transfers** | Add the three plane handles. For a floor-based blocking tool the XZ square is the one users will live in — it is the principled replacement for "drag the body and it slides on the floor". Colour each square after the axis it *locks*, matching Unity. | The current move gizmo's three arrows only, and the body-drag floor slide that stands in for a plane handle today. |
| Shift on the Move centre gives a camera-facing free-move square | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Transfers** | Add it. It is the fastest way to reposition something roughly, and it removes the last excuse for body-dragging. | Body-drag floor slide. |
| Rotate gizmo is a wireframe sphere of three axis rings **plus an outer screen-space circle** | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Transfers** | Add the outer circle (rotate about the view axis). Keep the three rings. | The current three bare world-axis rings with no screen-space ring. |
| Scale gizmo is three axis cubes **plus a centre cube for uniform scale** | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Transfers** | Already correct in CozyClay — three boxes plus a centre box (`BOX_SIZE`/`CENTRE_BOX` in `src/object-gizmo.jsx`). Keep it, and make sure the centre cube reads as uniform scale in the tooltip/cursor. | Nothing; this one already matches. |
| x/y/z = red/green/blue everywhere; the dragged handle turns yellow and stays highlighted | <https://docs.unity3d.com/Manual/class-Transform.html> | **Transfers** | Use the same colour language on the gizmo *and* on the Inspector transform rows so the two teach each other. Highlight the active handle yellow during and after a drag. | Whatever ad-hoc highlight the gizmo uses now; and Inspector rows that carry no axis colour at all. |
| Handles are constant screen size | <https://docs.unity3d.com/ScriptReference/HandleUtility.GetHandleSize.html> | **Transfers** | Already implemented via `SCREEN_SCALE = 0.16`. Keep, and keep the fat invisible pick proxies — that is the right technique. | Nothing. |
| Small gizmos fade out; selection outline orange, children blue | <https://docs.unity3d.com/Manual/GizmosMenu.html> | **Adapt** | Adopt the selection outline (orange) as the primary selected-state signal in the viewport. Child outlines are N/A without parenting. Fading is optional polish. | Whatever selected-state highlight exists now. |
| Dragging the object's mesh does **not** move it — only handles transform | <https://docs.unity3d.com/Manual/class-Transform.html> (transforms are performed by dragging gizmo axes) | **Transfers** | Remove body-dragging. A left-press on the body selects, full stop. Movement requires a handle. | The current "left press on an object body selects AND slides it on a horizontal plane" behaviour, which is why a click intended as a selection nudges the set. |

### 9.4 Handle/tool state

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Local / Global handle orientation toggle | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Transfers** | Add a two-state toggle near the tool buttons. In Local, draw the axes rotated by the object's own rotation and interpret arrow drags along the object's own axes. This matters the moment a user turns a wall 30° and wants to push it "into the room". | `src/scene-objects.js` stores rotation and scale strictly per world axis (`WORLD_AXES`, `ROTATION_KEYS`, `SCALE_KEYS`) and the gizmo only ever draws world axes — Local does not exist. Expect this to be the largest change of the set. |
| Grid handle orientation | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **N/A** | CozyClay has one axis-aligned room grid; a rotatable grid is machinery without a user. | — |
| Pivot / Center position toggle | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Adapt** | With single selection and no authored pivots, Pivot and Center would be identical, so do not ship a toggle that does nothing. Instead **define where the gizmo sits and state it**: at the object's bounds centre (today `gizmoHeight()` = `y + height/2`, floor-clamped). If multi-select ever lands, the toggle becomes meaningful — Center at the selection bounds centre, Pivot at the active object. | Nothing today; this documents and defends existing behaviour rather than changing it. |
| The "active" object supplies the pivot in a multi-selection; Shift-click changes which one is active | <https://docs.unity3d.com/Manual/SelectGameObjects.html> | **N/A** until multi-select exists | Note it as the rule to follow when multi-select is added. | — |
| Scale handles only appear in Local orientation on the combined tool | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **N/A** | Only applies to the combined Transform (Y) tool. | — |

### 9.5 Snapping

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Drags are continuous by default; **hold Ctrl/Cmd to snap to increments** | <https://docs.unity3d.com/Manual/SnapIncrements.html> | **Transfers** | Invert CozyClay's current polarity: drag freely, hold Ctrl/Cmd for 0.05 m / 5° / 5% steps. Show the snapped value in a HUD readout during the drag. | `TRANSLATE_SNAP = 0.05`, `ROTATE_SNAP = 5`, `SCALE_SNAP = 0.05` in `src/scene-objects.js`, applied unconditionally on every drag with no way to defeat them. Today a user physically cannot place something at 1.02 m. |
| Snapping can also be latched on permanently, per tool, from the Grid and Snap overlay | <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html>, <https://docs.unity3d.com/Manual/SnapIncrements.html> | **Adapt** | Keep a single "Snap" toggle (one for all three tools, not three) so the current always-snapped workflow remains available for people who prefer it — and because the plan board blocks on the same grid. When the toggle is on, Ctrl/Cmd inverts it and gives a free drag. | Nothing; this preserves today's behaviour as an option instead of a law. |
| Increment values are user-editable per tool | <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html> | **Adapt** | Expose the three increments (distance / angle / scale) in settings, defaulting to today's 0.05 m / 5° / 5%. Do not adopt Unity's 1-unit / 15° defaults: CozyClay's room is 13 m across with 5 cm props, and the plan board already blocks on the 5 cm grid. | Hard-coded constants. |
| Absolute grid snapping (snap to grid positions, not increments), Global/Grid orientation only | <https://docs.unity3d.com/Manual/GridSnap.html>, <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html> | **Adapt** | Worth one command rather than a mode: a **Push to Grid** action (Unity's Ctrl+\\) that rounds the selection onto the nearest grid point. Same benefit, far less state. | Nothing. |
| Surface snapping onto colliders (Shift+Ctrl / Shift+Cmd) | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Adapt** | There are no colliders, but there are boxes and a floor. Shipped as **End → drop to surface** (§9.2): strict drop-down onto the highest overlapping surface top at or below the base, or the floor. Unity's Shift+Ctrl / Shift+Cmd drag-modifier form — raycast down/at the cursor *while dragging* — is deferred; it needs a per-tick downward raycast on the drag hot path. | Nothing — Y was set only by typing or scrubbing, so objects floated or sank. |
| Vertex snapping with **V** | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Adapt (low priority)** | Full vertex snapping is overkill for greybox primitives. The transferable part is the *corner/edge* case: with V held, snap the dragged box's nearest bottom corner to another box's corner or edge midpoint. Defer until drop-to-surface ships. | Nothing. |
| Look-at rotation (Shift+Ctrl on a rotate handle) | <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Adapt (optional)** | For a shot-blocking tool, "aim this object at the camera / at the subject" is genuinely useful. Offer it as a context-menu command rather than a modifier drag. | Nothing. |

### 9.6 Selection semantics

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Left-click selects and does nothing else | <https://docs.unity3d.com/Manual/SelectGameObjects.html> | **Transfers** | Press on a body = select only. No transform, ever. | "Left press on an object body selects AND slides it on a horizontal plane". |
| Repeated clicks cycle through overlapping objects | <https://docs.unity3d.com/Manual/SelectGameObjects.html> | **Transfers** | Cycle by ray-hit depth on repeated clicks at the same screen position within a short window; reset the cycle when the cursor moves. | Nothing — today the frontmost hit always wins, so a box inside a box is unreachable in the viewport. |
| Ctrl/Cmd+right-click piercing menu names every candidate | <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html> | **Adapt** | Ship it; list objects by their hierarchy name. | Nothing. |
| Left-drag on empty space marquee-selects | <https://docs.unity3d.com/Manual/SelectGameObjects.html> | **Adapt** | Only meaningful once multi-select exists. Reserve the gesture now (left-drag on empty space must not fly the camera) even if v1 just shows the rectangle and selects the single topmost object inside it. | "Press on empty space flies the camera" — the behaviour that makes an accidental miss reposition the shot. |
| Click on empty space clears the selection | `[observed]` | **Transfers** | Clear the selection and hide the gizmo. | Empty-space press starting a camera look-drag. |
| Shift / Ctrl-click extends the selection | <https://docs.unity3d.com/Manual/SelectGameObjects.html> | **N/A** until multi-select exists | Note as the rule for when it does. | — |
| Clicking an already-selected object changes nothing | `[observed]` | **Transfers** | Idempotent. Notably this is what today's body-drag violates: re-clicking a selected object can move it. | Body-drag on the selected object. |
| Hierarchy and viewport share one selection | <https://docs.unity3d.com/Manual/Hierarchy.html>, <https://docs.unity3d.com/Manual/UsingTheInspector.html> | **Transfers** | Already true; keep it, and make the Hierarchy scroll the selected row into view when selection originates in the viewport. | Partially present (tree selection works); add the reverse scroll-into-view. |
| Per-object pickability lock (hand icon) | <https://docs.unity3d.com/Manual/ScenePicking.html>, <https://docs.unity3d.com/Manual/hierarchy-reference.html> | **Adapt (later)** | Useful once a set has a big floor slab or backdrop that swallows clicks. Low priority for v1. | Nothing. |

### 9.7 Hierarchy panel

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Creation lives in a menu organised by category (**GameObject > 3D Object > Cube/Sphere/…**) | <https://docs.unity3d.com/Manual/PrimitiveObjects.html> | **Transfers** | The existing "Add object" popover over the catalogue's `group` headings is already the right shape. Keep it, and add the same list to the Hierarchy right-click menu and the viewport right-click menu. | Only-one-entry-point creation via the popover button. |
| Right-click a row for a context menu: Rename, Duplicate, Cut/Copy/Paste, Delete | <https://docs.unity3d.com/Manual/Hierarchy.html> | **Transfers** | Add a row context menu with Rename, Duplicate, Delete, Frame (F) and Reset Transform. | `src/hierarchy-panel.jsx` `TreeRow` has `onSelect` only — no context menu at all. |
| New objects open in rename mode by default | <https://docs.unity3d.com/Manual/Hierarchy.html> | **Transfers** | Focus the new row's name field immediately after creation. Named greyboxes are the whole point of a blocking hierarchy. | Auto-generated names that can only be changed later from the Inspector card. |
| Rename in place with F2 / Return | `[community]` <https://discussions.unity.com/t/keyboard-shortcut-to-rename-gameobject/109770/2> | **Transfers** | In-place editable row label. | Inspector-only rename. |
| Duplicate with Ctrl+D / Cmd+D and from the context menu | <https://docs.unity3d.com/Manual/Hierarchy.html> | **Transfers** | Both entry points. Name the copy predictably (`Crate` → `Crate (1)`). | Nothing. |
| Rows are listed in creation order, newest last, and can be dragged to reorder | <https://docs.unity3d.com/Manual/Hierarchy.html> | **Adapt** | Keep creation order. Manual reordering is cosmetic without parenting; defer. | — |
| Drag-to-parent, Create Empty Parent, Paste as Child, default parent | <https://docs.unity3d.com/Manual/Hierarchy.html> | **N/A** | Explicitly out of scope: no parenting in CozyClay. | — |
| Per-row eye (visibility) and hand (pickability) icons | <https://docs.unity3d.com/Manual/hierarchy-reference.html> | **Adapt (later)** | The eye is worth having in a blocking tool — hide the backdrop to see the blocking behind it. Add after the interaction rebuild. | Nothing. |
| Adding/removing in the viewport adds/removes the row | <https://docs.unity3d.com/Manual/Hierarchy.html> | **Transfers** | Already true. | — |

### 9.8 Inspector Transform

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Three numeric fields on one row per Position / Rotation / Scale | <https://docs.unity3d.com/Manual/class-Transform.html> | **Transfers** | Three rows of three fields, axis-coloured, replacing nine stacked sliders. It is also ~⅓ of the vertical space, which matters in a narrow inspector. | The nine `Slider compact` widgets of the Object Transform card in `src/App.jsx` at the time (since removed). |
| Values are typed for precision | <https://docs.unity3d.com/Manual/class-Transform.html> | **Transfers** | Commit on Enter/blur, revert on Escape. | Sliders, which cannot express an exact typed value at all. |
| Dragging the field label scrubs the value | <https://docs.unity3d.com/Manual/class-Transform.html>, <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html> | **Transfers** | Horizontal (or vertical) drag on the axis label scrubs continuously with no end stops; Ctrl/Cmd during the scrub snaps to the same increment as the gizmo; Shift scrubs coarser. Cursor becomes a resize/scrub cursor on hover. | Slider tracks whose precision depends on panel width. |
| Sliders are reserved for genuinely bounded properties | <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html> | **Transfers** | No sliders on transform values. CozyClay's clamps (±6.5 m room, 6 m ceiling, scale 0.1–5 in `src/scene-objects.js`) are *safety rails*, not a user-facing range — enforce them on commit and show a subtle out-of-range hint, do not turn them into a track the user must aim along. Keep sliders for things that really are bounded, like the camera FOV slider. | The framing of room limits as slider min/max. |
| Numeric fields evaluate expressions (`2+3`, `*=2`, `R(a,b)`) | <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html> | **Adapt (optional)** | `+=`/`-=`/`*=` and plain arithmetic are cheap and genuinely used when blocking (`*=2` on a scale row). `L()`/`R()` are multi-select features — skip. | Nothing. |
| Constrained Proportions toggle on the Scale row | <https://docs.unity3d.com/Manual/class-Transform.html> | **Transfers** | A link toggle on the Scale row that keeps the three axes proportional, off by default. It is the Inspector twin of the gizmo's centre cube. | Nothing — today uniform scaling from the Inspector means editing three sliders by hand. |
| Rotation is Euler degrees per axis | <https://docs.unity3d.com/Manual/class-Transform.html> | **Transfers** | Matches `rotX`/`rot`/`rotZ`. Keep, but stop wrapping the display to [-180, 180) mid-edit — let the user type 270. | `wrapAngle()` being applied as a display law as well as a storage law. |

### 9.9 Cross-cutting: gizmo/tool state surfaced in the UI

| Unity rule | Doc source | Verdict | What CozyClay should do | Replaces |
| --- | --- | --- | --- | --- |
| Tool selection, handle position/rotation toggles and snapping all live in always-visible Scene view overlays | <https://docs.unity3d.com/Manual/overlays.html>, <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html> | **Adapt** | Put the tool buttons (Q/W/E/R), the Local/Global toggle and the Snap toggle in a small overlay strip **in the viewport**, not only in the right-hand inspector card. The state that changes what a drag means must be visible where the drag happens. | Mode buttons that live only inside the "Object Transform" card, which is hidden entirely when nothing is selected. |
| Tool state persists across selections | implied throughout <https://docs.unity3d.com/Manual/PositioningGameObjects.html> | **Transfers** | Keep the active tool, orientation and snap state when the selection changes — do not reset to Move. | Verify current behaviour; `gizmoMode` is app-level state so this likely already holds. |

---

## 10. Ranked changes, biggest payoff first

1. **Move camera look from left-drag to right-button-hold (flythrough), and gate W/A/S/D/Q/E behind that hold.** Every other problem is downstream of the left button being owned by the camera; this one change frees click-to-select, marquee, plane handles and the W/E/R hotkeys in a single move. (<https://docs.unity3d.com/Manual/SceneViewNavigation.html>)
2. **Make a left-press on an object body select only — delete the body-drag floor slide.** Selection must be a safe, idempotent act; today aiming at an object to look at its numbers moves the set. (<https://docs.unity3d.com/Manual/SelectGameObjects.html>, <https://docs.unity3d.com/Manual/class-Transform.html>)
3. **Rebind the tools to W = Move, E = Rotate, R = Scale, Q = view/pan.** G/R/T is a private dialect, and its **R** means the opposite of Unity's **R**; every 3D-literate user arrives already knowing the right one. (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/SceneViewNavigation.html>)
4. **Invert snapping: free drag by default, Ctrl/Cmd to snap, with a persistent Snap toggle.** The hard-coded 5 cm / 5° / 5% grid currently makes some placements unreachable; Unity's polarity gives precision on demand without taking away exactness. (<https://docs.unity3d.com/Manual/SnapIncrements.html>)
5. **Replace the nine sliders with three rows of three typed, drag-scrubbable, axis-coloured fields.** Unbounded, exact, one third of the vertical space, and it finally teaches the same red/green/blue language as the gizmo. (<https://docs.unity3d.com/Manual/class-Transform.html>, <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html>)
6. **Add the missing Move handles: three plane squares plus the Shift camera-facing free-move square.** This is the legitimate replacement for body-dragging, and the XZ plane handle is how a set gets dressed. (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>)
7. **Add F to frame the selection (Shift+F to lock).** In a walk-around tool the camera loses the set constantly, and there is currently no way back. One key, enormous relief. (<https://docs.unity3d.com/Manual/SceneViewNavigation.html>)
8. **Add a Local/Global handle-orientation toggle.** The moment a prop is rotated, world-only axes stop matching the user's mental model; this is the largest change on the list because rotation and scale are stored per world axis today, which is exactly why it should be decided now rather than retrofitted later. (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>)
9. **Add Ctrl/Cmd+D duplicate, a hierarchy row context menu, and in-place rename (F2/Return, plus rename-on-create).** Blocking is iterate-by-copy work; the current "re-add from the catalogue and re-place by hand" loop is the slowest path in the app. (<https://docs.unity3d.com/Manual/Hierarchy.html>)
10. **Add overlap resolution: click-cycling plus a Ctrl/Cmd+right-click piercing menu.** Greybox sets are full of boxes inside boxes, and today anything behind another object is unreachable from the viewport. (<https://docs.unity3d.com/Manual/SelectGameObjects.html>, <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html>)
11. **Add the outer screen-space rotation ring.** Cheap, and it is the only way to roll an object about the view axis without hunting for a favourable camera angle. (<https://docs.unity3d.com/Manual/PositioningGameObjects.html>)
12. **Add Escape to cancel an in-flight drag, and Shift+Ctrl / Shift+Cmd "drop to surface" during a move.** Undo-by-abort and rest-on-the-floor remove the two most common mid-drag frustrations. (Escape: CozyClay-specific, not documented by Unity. Surface snap: <https://docs.unity3d.com/Manual/PositioningGameObjects.html>)
13. **Move the tool/orientation/snap controls into a viewport overlay, and show the selection with an orange outline.** State that changes the meaning of a drag has to be visible next to the drag, not inside a card that disappears when nothing is selected. (<https://docs.unity3d.com/Manual/overlays.html>, <https://docs.unity3d.com/Manual/GizmosMenu.html>)

---

## Appendix: source ledger

| Area | Official pages used |
| --- | --- |
| Navigation, flythrough, framing | <https://docs.unity3d.com/Manual/SceneViewNavigation.html>, <https://docs.unity3d.com/Manual/UsingTheSceneView.html> |
| Tools, gizmos, snapping modifiers, handle toggles | <https://docs.unity3d.com/Manual/PositioningGameObjects.html>, <https://docs.unity3d.com/Manual/class-Transform.html> |
| Context menu, piercing menu, picking, selection | <https://docs.unity3d.com/Manual/SceneViewContextMenu.html>, <https://docs.unity3d.com/Manual/SelectionPiercingMenu.html>, <https://docs.unity3d.com/Manual/ScenePicking.html>, <https://docs.unity3d.com/Manual/SelectGameObjects.html> |
| Snapping and the grid | <https://docs.unity3d.com/Manual/GridSnapping.html>, <https://docs.unity3d.com/Manual/GridSnap.html>, <https://docs.unity3d.com/Manual/SnapIncrements.html>, <https://docs.unity3d.com/Manual/CustomizeGrid.html>, <https://docs.unity3d.com/Manual/GridShortcuts.html>, <https://docs.unity3d.com/Manual/overlay-grid-snap-reference.html> |
| Hierarchy | <https://docs.unity3d.com/Manual/Hierarchy.html>, <https://docs.unity3d.com/Manual/hierarchy-reference.html> |
| Inspector and value editing | <https://docs.unity3d.com/Manual/UsingTheInspector.html>, <https://docs.unity3d.com/2021.3/Documentation/Manual/EditingValueProperties.html> |
| Gizmo drawing conventions | <https://docs.unity3d.com/Manual/GizmosMenu.html>, <https://docs.unity3d.com/ScriptReference/HandleUtility.GetHandleSize.html> |
| Overlays, shortcuts, primitives | <https://docs.unity3d.com/Manual/overlays.html>, <https://docs.unity3d.com/Manual/ShortcutsManager.html>, <https://docs.unity3d.com/Manual/PrimitiveObjects.html> |

Community sources, used only where the manual is silent and marked `[community]` in the text:

- Rename shortcut (F2 / Return): <https://discussions.unity.com/t/keyboard-shortcut-to-rename-gameobject/109770/2>
- Default increment snap values as shipped: <https://www.ketra-games.com/2020/08/unity-game-tutorial-increment-snap-and-grid-alignment.html>

Items marked `[observed]` are behaviours consistent across Unity versions that the manual does not spell out: clicking empty space clears the selection, the Delete key deletes, clicking an already-selected object is a no-op, and Escape's role in the Scene view.


---

## 8. Editor window layout (2026-08-10)

Sections 1–6 cover interaction; this section records where the windows sit.
CozyClay follows Unity's default editor arrangement. The chrome (top bar,
hierarchy, inspector, bottom window, brandbar) wears a Unity 6 dark-editor
skin — palette tokens pinned by test/verify-theme.mjs — while the 3D stage
keeps the bright lightbox set on purpose: the bird's-eye plan board reads as
part of that set, so it stays light too. Surfaces with no Unity counterpart
keep their own look.

| Unity window | CozyClay counterpart | Notes |
| --- | --- | --- |
| Toolbar (tool switch, snap) | Top bar: Move / Rotate / Scale switch bound to the same state as the W / E / R hotkeys, plus the Snap toggle | The RectTransform (T) and Transform (Y) tools have no CozyClay meaning and are omitted |
| Hierarchy (left) | Left window: shot structure tree with the create catalogue and the right-click row menu (§9.7) | Always visible; the former tab strip is gone |
| Scene view (centre) | Shot viewport | The Shot view / Bird's-eye toggle is a scene-view overlay in Unity's overlay-toolbar position (top-left); the bird's-eye plan board stays a draggable inset pane |
| Inspector (right) | Right window: the selection's properties as collapsible foldout sections (▸/▾) | Sections default to open; fold state is session-local |
| Scene / Game tabs | Center pane tabs: **Scene** (the editing view) and **PlayView** (framed output only — no gizmo, inset, fly navigation, or overlays) | PlayView renders the shot camera full-frame; switching tabs never remounts the canvas |
| Animation (bottom) | Bottom window, "Animation" tab: the Prompt-Block / IK / Root-Path sequencer | Named for Unity's Animation window; Console remains the second tab |
| Console (bottom) | Bottom window, "Console" tab: the session history of ARDY status lines, newest at the bottom | The inspector still shows the current line; the tab accumulates |

Deliberate divergences:

1. **No menu bar.** Unity's File/Edit/Assets menus would be fake buttons here; the Controls popover keeps the shortcut reference instead.
2. **No dockable windows.** Panels resize via splitters (persisted in localStorage) but cannot be torn off — browser layout cost outweighs the benefit.
3. **Pose studio stays a modal overlay** (Unity's modal window equivalent) and the plan board stays an inset pane inside the scene view, because neither has a Unity docking counterpart.
4. **The brandbar remains** as a slim status strip under the bottom window; Unity's equivalent status text lives inside its windows instead.
5. **Widget material is Unity flat**: 1px borders, 2px corners, no gradients or glows on buttons, inputs, selects, sliders, dialogs, or foldout section bars. Unity's exact 19px row metrics and 1px bevels are approximated, not measured.
