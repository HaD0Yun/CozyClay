// The surface layer of the finish (src/stage-finish-surface.js): the shader chunk patch took in this three version, and
// applySurfaceLook puts the look on materials and on the rig's fill lights. The module is evaluated from its source
// with the two layer constants it imports from a .jsx file handed in; three itself is real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";

const source = readFileSync(new URL("../src/stage-finish-surface.js", import.meta.url), "utf8");
const body = source.replace(/^import .*$/gm, "").replace(/^export /gm, "");
const GIZMO_LAYER = 5, POSER_LAYER = 4;
const chunks = { ...THREE.ShaderChunk };
const { applySurfaceLook, installSurfaceLooks } = new Function("THREE", "GIZMO_LAYER", "POSER_LAYER", `${body}; return { applySurfaceLook, installSurfaceLooks };`)({ ...THREE, ShaderChunk: chunks }, GIZMO_LAYER, POSER_LAYER);

// Every replacement found its stock line: a three upgrade that rewrites one would leave that part of the look out silently.
assert.equal(installSurfaceLooks(chunks), true);
for (const [chunk, marks] of Object.entries({
	lights_physical_pars_fragment: ["if ( ! cozyStockLamp ) dotNL = COZY_BANDS_LEVEL * ( dot( directLight.direction, directLight.direction ) < 0.5 ? 0.5 :", "cosineWeightedIrradiance * COZY_FILL_GAIN", "irradiance * COZY_FILL_GAIN * BRDF_Lambert", "#define COZY_FILL_GAIN COZY_FILL"],
	shadowmap_pars_fragment: ["shadow = smoothstep( 0.42, 0.58, shadow );", "float phi = 0.0;", "shadowRadius = clamp( shadowRadius, 1.0, 2.0 );"],
	lights_pars_begin: ["#if defined( COZY_BANDS ) && ! defined( COZY_LAMP_STOCK )", "min( distanceFalloff, cozyLevel )", "hemiDiffuseWeight = 0.5 * smoothstep( - 0.52, - 0.48, dotNL )"],
	lights_fragment_maps: ["getIBLIrradiance( cozySide )"],
	lights_physical_fragment: ["material.specularF90 = 0.0;"],
})) for (const mark of marks) assert.ok(chunks[chunk].includes(mark), `${chunk} carries: ${mark}`);
assert.equal(chunks.shadowmap_pars_fragment.split("float phi = 0.0;").length - 1, 2, "the spot/directional filter and the point filter both drop the noise");
assert.equal(chunks.lights_fragment_begin.split("cozyStockLamp = true;").length - 1, 2, "the point and the spot loop mark their lights as lamps");
assert.equal(chunks.lights_fragment_begin.split("cozyStockLamp = false;").length - 1, 1, "the directional loop takes the mark back");
assert.ok(!chunks.lights_fragment_begin.includes("NUM_DIR_LIGHT_SHADOWS )\n\t\t\tcozy"), "a light's step does not depend on whether it casts a shadow");

// A scene: the deck (its own fill gain), a prop, a pane of glass, a gizmo, the rig's fill and a placed directional light.
const scene = new THREE.Scene();
const mesh = (material, layer) => { const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material); if (layer) node.layers.enable(layer); scene.add(node); return node; };
const deck = mesh(new THREE.MeshPhysicalMaterial()), prop = mesh(new THREE.MeshStandardMaterial()), unlit = mesh(new THREE.MeshBasicMaterial());
const glass = mesh(new THREE.MeshPhysicalMaterial({ transmission: 0.9 })), gizmo = mesh(new THREE.MeshStandardMaterial(), GIZMO_LAYER);
Object.assign(deck.material.userData, { surfaceFill: 1, surfaceLampStock: true });
const fill = new THREE.DirectionalLight("#ffffff", 0.3), placed = new THREE.DirectionalLight("#ffb070", 1.5);
fill.position.set(-6, 4, -4);
fill.userData.fillLight = true;
placed.position.set(5, 3, 2);
scene.add(fill, placed);
const toon = { bands: { level: 0.75, fill: 2.2, pool: 0.6, poolAt: 0.5, poolSoft: 0.35, reach: 8 } };
const direction = (light) => new THREE.Vector3().setFromMatrixPosition(light.matrixWorld).sub(new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld));

scene.updateMatrixWorld(true);
applySurfaceLook(scene, toon);
assert.equal(prop.material.defines.COZY_BANDS, "");
assert.equal(prop.material.defines.COZY_FILL, "2.2", "a surface takes the look's fill gain");
assert.equal(deck.material.defines.COZY_FILL, "1.0", "a material with its own fill gain keeps it");
assert.equal(deck.material.defines.COZY_BANDS_LEVEL, "0.75", "and takes the rest of the look like every surface");
assert.equal(deck.material.defines.COZY_LAMP_STOCK, "", "a material that asks for the stock lamp falloff gets it");
assert.equal(prop.material.defines.COZY_LAMP_STOCK, undefined, "every other surface takes the lamp's flat pool");
assert.equal(unlit.material.defines, undefined, "an unlit material is left alone");
assert.equal(gizmo.material.defines?.COZY_BANDS, undefined, "editor furniture never takes the look");
assert.deepEqual([glass.material.transmission, glass.material.transparent], [0, true], "glass under the look is a plain tinted pane");
assert.equal(direction(fill).length(), 0, "a fill light has no direction under the bands: the shader lights every face alike from it");
assert.ok(direction(placed).length() > 1, "a placed directional light keeps its direction, shadow or not");
const version = prop.material.version;
applySurfaceLook(scene, toon);
assert.equal(prop.material.version, version, "the same look again recompiles nothing");

applySurfaceLook(scene, null);
assert.equal(prop.material.defines.COZY_BANDS, undefined);
assert.deepEqual([deck.material.defines.COZY_FILL, deck.material.defines.COZY_LAMP_STOCK], [undefined, undefined]);
assert.equal(glass.material.transmission, 0.9, "the pane's own transmission comes back with the look off");
assert.deepEqual(direction(fill).toArray(), [-6, 4, -4], "with the look off the fill light aims where it did");
console.log("PASS the finish's surface patch and applySurfaceLook");
