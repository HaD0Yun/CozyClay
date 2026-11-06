# Physical motion bench

`test/bench/physics/` compares CozyClay and Blender on ten hard physical motions built from scratch in an empty scene: muscle-up, handstand, two forward rolls, army crawl, wall climb, a trip while running, a backward fall off a roof, a barbell overhead, a rooftop gap jump and pushing a heavy crate. The same model and effort run on both sides. CozyClay runs through its Studio Agent panel. Blender runs through Claude Code (`claude -p`) with the official Blender Lab MCP server 1.0.3. Each run is measured on completion, time, cost, wasted effort and stability, and a human judges the results blind.

It uses a real model, a live Studio and a local Blender, so it is not part of the default `node tools/run-tests.mjs` manifest. This page covers the parts that exist so far: the sets, the two scene builders and the shared result file.

## Sets

`sets/NN-<motion>.json` holds one task each: the request sentence (Korean and English), 24 fps, a 20 s maximum, one Y Bot (`char-a`), and the objects.

| Field | Meaning |
| --- | --- |
| `character.position` | Feet origin. Every set faces the character toward +Z. |
| `objects[].shape` | `box`, `cylinder` (with `axis` x, y or z) or `group` (an empty parent) |
| `objects[].center`, `size` | Geometric centre and world extent along X, Y, Z, in metres. For a cylinder along X, `size` is [length, diameter, diameter]. |
| `objects[].fixed` | It never moves (walls, roofs, the bar, the net) |
| `objects[].mass` | kg, for an object that can move (the barbell group, the crate) |
| `objects[].parent` | The group this body belongs to |

Set coordinates use CozyClay axes: metres, +Y up, the floor at y = 0, the character faces +Z, and +X is the character's left. Blender is +Z up and the imported Y Bot faces -Y, so a set point (x, y, z) is Blender (x, -z, y).

Mass is never a CozyClay scene field. The motion spec sets it (`spec.objects[id].mass`, `src/motion3/mass.js`), so both agents get it in the request text.

## Request

`sets.mjs` `requestText(set, tool)` writes the one message a run sends: the Korean task sentence, a scene description in that tool's own axes (object ids, centres, sizes, masses; for Blender also the armature name and its 65 `mixamorig:` bone names), and the rules (no pre-made motions, the allowed tools, and where the result must stay).

## Scene builders

| Tool | Builder | Output |
| --- | --- | --- |
| CozyClay | `node test/bench/physics/build-cozyclay.mjs <set> [--out f]` | A project document (Animation, rigged cast), opened with `window.__cozyclayProject.open` |
| Blender | `blender -b --factory-startup --python test/bench/physics/blender/build_scene.py -- <set.json> <y-bot-tpose.fbx> <out.blend> [bounds.json]` | A .blend at 24 fps, frames 0 to 239, with the Y Bot armature `char-a`, a floor, a camera and a sun |

CozyClay records sit on their base pivot (bottom centre) and turn by Euler XYZ in degrees. A cylinder along X is therefore a Y cylinder turned `rotZ` -90 with its pivot at the -X end. Blender objects are built with their transforms applied (identity rotation, unit scale), are named by their set id, and carry `mass` and `fixed` custom properties.

The Y Bot is a Mixamo file, so the builder loads `public/models/y-bot-tpose.fbx` at build time and no .blend is committed. Blender's FBX import gives the armature scale 0.01 and a 90° X rotation, with the hips at 0.998 m. The builder sets the scene back to 24 fps (the import sets 30).

## Check: both tools open a set at the same coordinates

```sh
node test/bench/physics/check-sets.mjs [--sets 1,5] [--out dir] [--blender /opt/blender-5.2.0-linux-x64/blender] [--port 6300]
```

The check builds every set in both tools. It opens the documents in a headless Studio (dev server on `--port`, live hub on +1, CDP on +2, a fresh config home) and reads each object's world bounds with `cclay live inspect --scope entities --limit 32` (the editor caps a page at 32). It reads the .blend bounds that `build_scene.py` writes. Both are compared with the bounds the set itself implies: a body is its centre ± size / 2, and a group is the union of its children. The check passes when every object and the character root are within 1 mm in both tools.

## take.json: one result format for both tools

After a run the harness exports the result; the agent never does. `take.mjs` holds the format and the landmarks.

| Field | Meaning |
| --- | --- |
| `frames`, `fps` | Frame count from the first exported frame, 24 fps |
| `rig.bones` | The 65 Y Bot bones (`mixamorig:Hips`, ...), CozyClay rig order |
| `characters["char-a"].bones` | `[frame][bone]` row-major 4x4 world matrices in set axes, with the CozyClay rig's bone frames |
| `objects[id].matrix` | `[frame]` matrices of each set object at its centre (a group: its root). One entry: it never moved. Empty: the agent deleted it. |
| `source` | Tool, set, run, model, effort, and what the exporter saw |

`landmarksAt(take, id, f)` gives 29 points as fixed offsets on bones, measured once on the rig at rest: 2 palms (midway from the wrist to the middle knuckle), 10 fingertips, 6 sole points (the QA heel, ball and toe tip), 2 knees, 2 elbows, the hips, the buttocks (8 cm below and 11 cm behind the hips joint), 3 spine points, the chest (5 cm above and 11 cm ahead of Spine2) and the head top. The scorer uses the same code for both tools.

| Tool | Exporter |
| --- | --- |
| CozyClay | `node test/bench/physics/export-cozyclay.mjs <doc> <set> --out take.json`. It compiles char-a's installed spec again in Node with the Studio's `compileSpec` and `motionScene` (as `test/bench/motion-track.mjs` does) and writes the compile's world bone frames. |
| Blender | `blender -b <run.blend> --python test/bench/physics/blender/export_take.py -- <set.json> <take.json>` over the scene's frame range |

Blender bones have their own frames (+Y along the bone) under an armature turned 90° about X and scaled 0.01. `blender/take_io.py` therefore maps each bone through one constant correction measured at rest, `C_b = (A · BASIS · L_b)⁻¹ · M_rest_b`. It uses the bone rests that `build_scene.py` stored at build time, so an agent that edits the rest pose still exports through the bind it was given. `blender/import_take.py` keys a take onto a set's .blend: it is used for this check and to render either tool's result with the same renderer.

### Check: round trip through Blender

```sh
node test/bench/physics/check-take.mjs [--out dir] [--blender path]
```

The check installs a test-only spec (standIdle, a back tuck, a cartwheel) on set 10 and exports it from CozyClay. It gives the crate a made-up slide, yaw and tilt. Then it keys the take onto the .blend, exports it again, and compares every frame. Keyed in Blender, no bone below the hips may need a translation or a scale. A round trip alone would not catch a wrong bone map, but a wrong map shows up as stretch. Measured on the bench box (Blender 5.2.0): landmarks within 0.0032 mm, bone origins 0.0035 mm, crate 0.0002 mm, largest stretch below the hips 0.0020 mm, Blender rest heads vs the rig 0.0011 mm. Tolerance is 1 mm. It takes 6 s.
