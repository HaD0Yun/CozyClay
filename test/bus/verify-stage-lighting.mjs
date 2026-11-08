// The stage look (stage.lighting, keyLight.color), its recipes, stage.applyLighting's
// one undo step, and the verify_result lighting measurement.
import assert from 'node:assert/strict';
import { createSceneStage } from '../../src/scenes.js';
import { applyLightingRecipe, createKeyLight, hazeRange, LIGHTING_PRESETS, LIGHTING_RECIPES, normalizeLighting, stageLook } from '../../src/stage-lighting.js';
import { frameLighting, lightingChecks } from '../../src/studio-lighting-check.js';
import { stageFixture } from './stage-fixture.mjs';
import { ShaderChunk } from 'three';
import { installSoftShadows } from '../../src/soft-shadows.js';

const STUDIO = { preset: 'studio', sky: null, skyTop: null, ambient: 1, hemiSky: '#ffffff', hemiGround: '#5a5d64', fill: 1, fog: 0, exposure: 1, shadowSoftness: 0, envLight: 0, ao: 0, hdr: null, hdrRotation: 0, hdrIntensity: 1, hdrBackground: true };
// The studio look's key is the new-project default: a bright neutral sun (brightness 3, warmth 0).
const STUDIO_KEY = { x: 6, y: 9, z: 4, intensity: 3, warmth: 0, color: null };

// Normalization: an old stage (no lighting, no key colour) gets the studio look.
const legacy = createSceneStage({ keyLight: { x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 } });
assert.deepEqual(legacy.lighting, STUDIO);
// ...but keeps the key it was saved with (only a stage with no key takes the new default).
assert.deepEqual(legacy.keyLight, { ...STUDIO_KEY, intensity: 1.12, warmth: 0.5 });
assert.deepEqual(createSceneStage(null).lighting, STUDIO);
assert.deepEqual(normalizeLighting({ preset: 'noon', sky: 'blue', skyTop: '#12345', ambient: 9, fill: -1, fog: 2, exposure: 0, shadowSoftness: 'soft', hemiSky: null }),
  { ...STUDIO, ambient: 3, fill: 0, fog: 1, exposure: 0.2 }, 'bad values clamp or fall back to studio');
assert.deepEqual(normalizeLighting({ preset: 'night', sky: '#0B1426', exposure: 1.4 }), { ...STUDIO, preset: 'night', sky: '#0B1426', exposure: 1.4 }, 'valid values survive as given');
assert.equal(createKeyLight({ color: '#9db6e6' }).color, '#9db6e6');
assert.equal(createKeyLight({ color: 'cyan' }).color, null);
assert.deepEqual(createSceneStage(createSceneStage({ lighting: { preset: 'golden', fog: 0.3 } })).lighting, createSceneStage({ lighting: { preset: 'golden', fog: 0.3 } }).lighting, 'normalization is idempotent');
console.log('PASS lighting normalization: studio default for old stages, clamps, colour validation, idempotent');

// The studio look renders the tuned rig: the exact numbers StageLights and the canvas used before,
// measured at the reference key (1.12) the fill and rim scale from.
const REFERENCE_KEY = { ...STUDIO_KEY, intensity: 1.12, warmth: 0.5 };
const studio = stageLook({ lighting: null, keyLight: REFERENCE_KEY });
assert.deepEqual({ sky: studio.sky, skyTop: studio.skyTop, fog: studio.fog, captureFog: studio.captureFog, hemi: studio.hemi, ambient: studio.ambient, exposure: studio.exposure, shadowRadius: studio.shadowRadius, shadowNormalBias: studio.shadowNormalBias, lightDeck: studio.lightDeck },
  { sky: '#232428', skyTop: null, fog: { color: '#232428', near: 18, far: 54 }, captureFog: null, hemi: { sky: '#ffffff', ground: '#5a5d64', intensity: 0.9 }, ambient: 0.18, exposure: 1, shadowRadius: 1, shadowNormalBias: 0.02, lightDeck: false });
assert.ok(Math.abs(studio.fill - 0.36) < 1e-12 && Math.abs(studio.rim - 0.22) < 1e-12);
const lightTheme = stageLook({ lighting: STUDIO, keyLight: STUDIO_KEY, theme: 'light' });
assert.deepEqual([lightTheme.sky, lightTheme.hemi.ground, lightTheme.ambient, lightTheme.lightDeck], ['#e7e8eb', '#d6d8de', 0.32, true]);
const grid = stageLook({ lighting: STUDIO, keyLight: STUDIO_KEY, grid: true, theme: 'light' });
assert.deepEqual([grid.sky, grid.fog, grid.hemi.ground, grid.ambient], ['#232428', { color: '#232428', near: 30, far: 54 }, '#3a3d42', 0.34]);
assert.deepEqual(hazeRange(0), { near: 55, far: 95 }, 'no haze keeps the export horizon');
assert.deepEqual(hazeRange(1), { near: 2, far: 14 });
console.log('PASS studio look equals the tuned rig under both themes and the grid view');

// Recipes: complete, and each preset writes what its name promises.
assert.deepEqual(Object.keys(LIGHTING_RECIPES), [...LIGHTING_PRESETS]);
const base = createSceneStage(null);
const applied = Object.fromEntries(LIGHTING_PRESETS.map(preset => [preset, applyLightingRecipe(base, preset)]));
for (const preset of LIGHTING_PRESETS) {
  assert.equal(applied[preset].lighting.preset, preset);
  assert.deepEqual(normalizeLighting(applied[preset].lighting), applied[preset].lighting, `${preset} is already normalized`);
}
assert.deepEqual(applied.studio, { lighting: STUDIO, keyLight: STUDIO_KEY }, 'studio is exactly the default');
const luma = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const night = applied.night;
assert.ok(luma(night.lighting.sky) < 0.1 && luma(night.lighting.skyTop) < luma(night.lighting.sky), 'night: a dark sky, darker overhead');
assert.ok(rgb(night.lighting.sky)[2] > rgb(night.lighting.sky)[0], 'night: the sky is blue-black');
assert.ok(rgb(night.keyLight.color)[2] > rgb(night.keyLight.color)[0] && night.keyLight.intensity < 0.7, 'night: a dim cool moon key');
assert.ok(night.lighting.ambient < 1 && rgb(night.lighting.hemiSky)[2] > rgb(night.lighting.hemiSky)[0], 'night: low cool ambient');
assert.ok(night.lighting.fog > 0.3 && night.lighting.shadowSoftness >= 0.5, 'night: haze and soft shadows');
assert.ok(applied.golden.keyLight.y < 4 && rgb(applied.golden.keyLight.color)[0] > rgb(applied.golden.keyLight.color)[2], 'golden: a low warm sun');
assert.deepEqual([applied.stage.lighting.sky, applied.stage.lighting.ambient, applied.stage.lighting.fill], ['#000000', 0, 0], 'stage: a black void lit by the key alone');
assert.ok(applied.overcast.lighting.shadowSoftness === 1 && applied.overcast.keyLight.intensity < 1, 'overcast: soft, dim key');
const moved = createSceneStage({ keyLight: { x: -3, y: 5, z: 7, intensity: 2, warmth: 0.9 }, lighting: { exposure: 1.6 } });
const kept = applyLightingRecipe(moved, 'night', ['keyLight.position', 'lighting.exposure']);
assert.deepEqual([kept.keyLight.x, kept.keyLight.y, kept.keyLight.z, kept.lighting.exposure], [-3, 5, 7, 1.6], 'keep holds the listed paths back');
assert.equal(kept.keyLight.intensity, night.keyLight.intensity);
assert.equal(applyLightingRecipe(moved, 'studio').keyLight.warmth, 0, 'studio resets warmth to the neutral default (0)');
assert.throws(() => applyLightingRecipe(base, 'disco'), /Unknown lighting preset/);
console.log('PASS recipes: all presets, studio exact, night/golden/stage/overcast promises, keep');

// stage.applyLighting: one undoable receipt, then stage.set tweaks the explicit values.
const f = stageFixture();
try {
  const before = structuredClone(f.stage.read());
  const receipt = f.run('stage.applyLighting', { preset: 'night' }, 'agent');
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.undo.entries, 1);
  assert.equal(receipt.revision.after, receipt.revision.before + 1);
  assert.deepEqual(f.stage.read().lighting, night.lighting);
  assert.deepEqual(f.stage.read().keyLight, night.keyLight);
  const patched = receipt.delta[0].after.patched;
  assert.deepEqual(patched.find(row => row.path === 'stage.lighting.sky'), { path: 'stage.lighting.sky', text: night.lighting.sky }, 'the receipt reads the new look back');
  assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }, 'agent').status, 'undone');
  assert.deepEqual(f.stage.read(), before, 'one undo restores the whole previous look');
  assert.equal(f.run('stage.applyLighting', { preset: 'golden', keep: ['keyLight.position'] }, 'agent').ok, true);
  assert.deepEqual([f.stage.read().keyLight.x, f.stage.read().lighting.preset], [before.keyLight.x, 'golden']);
  const tweak = f.run('stage.set', { lighting: { exposure: 1.3, sky: null }, keyLight: { color: '#ffffff' } }, 'agent');
  assert.equal(tweak.ok, true, JSON.stringify(tweak));
  assert.deepEqual([f.stage.read().lighting.exposure, f.stage.read().lighting.sky, f.stage.read().lighting.preset, f.stage.read().keyLight.color], [1.3, null, 'golden', '#ffffff']);
  assert.equal(f.run('stage.set', { lighting: { preset: 'night' } }, 'agent').ok, false, 'the preset label is written only by applyLighting');
  assert.equal(f.run('stage.applyLighting', { preset: 'disco' }, 'agent').ok, false);
  assert.equal(f.run('stage.applyLighting', { preset: 'studio' }, 'agent').ok, true);
  assert.deepEqual([f.stage.read().lighting, f.stage.read().keyLight], [STUDIO, STUDIO_KEY], 'studio puts the tuned rig back');
  console.log('PASS stage.applyLighting: one receipt, one undo, keep, explicit tweaks after, studio restores');
  // verify_result checks ["lighting"] through the real binding: unsupported without a renderer, measured with one.
  const verify = () => f.binding.handlers.verify_result(f.request('verify_result', { targets: ['actor-a'], checks: ['lighting'] }));
  const renderer = f.ports.renderFrameBuffer;
  f.ports.renderFrameBuffer = undefined;
  const missing = await verify();
  assert.deepEqual([missing.unsupportedChecks, missing.unsupportedReasons.lighting], [['lighting'], 'This editor cannot render the shot frame.'], JSON.stringify(missing));
  const rendered = [];
  f.ports.renderFrameBuffer = frame => (rendered.push(frame), { width: 32, height: 18, data: new Uint8Array(32 * 18 * 4).fill(51) });
  const measured = await verify();
  assert.deepEqual(measured.unsupportedChecks, [], JSON.stringify(measured));
  assert.deepEqual({ ...measured.checks.lighting, subjects: measured.checks.lighting.subjects.map(row => row.id) },
    { coverage: 'rendered-shot-frame', frame: f.binding.refresh().view.frame, meanLuma: 0.2, clippedPct: 0, crushedPct: 0, subjects: ['actor-a'], look: { preset: 'studio', envLight: 0, ao: 0 } });
  assert.deepEqual(rendered, [f.binding.refresh().view.frame], 'one render of the playhead frame');
  f.ports.renderFrameBuffer = renderer;
  console.log('PASS verify_result lighting through the binding: refused without a renderer, measured from the rendered frame');
} finally { f.dispose(); }

// The measurement: a synthetic frame with a bright box on a dark ground.
const width = 40, height = 20, data = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const i = (y * width + x) * 4, inside = x >= 10 && x < 20 && y >= 5 && y < 15;
  data.set(inside ? (x < 15 ? [255, 255, 255, 255] : [128, 128, 128, 255]) : [0, 0, 0, 255], i);
}
const stats = frameLighting({ data, width, height }, [{ id: 'a', x0: 10, x1: 19, y0: 5, y1: 14 }, { id: 'gone' }]);
assert.deepEqual(stats, { meanLuma: Number(((50 * 255 + 50 * 128) / 800 / 255).toFixed(3)), clippedPct: 6.3, crushedPct: 87.5,
  subjects: [{ id: 'a', meanLuma: Number(((50 * 255 + 50 * 128) / 100 / 255).toFixed(3)), contrast: Number((1 - 128 / 255).toFixed(3)) }, { id: 'gone', meanLuma: null, contrast: null }] });
// lightingChecks projects a character's world box through the shot camera onto the rendered pixels.
const state = { frame: 3, camera: { position: { x: 0, y: 1, z: 4 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35 }, filmback: { sensorId: 'super35', aspectRatio: 16 / 9 },
  characters: [{ id: 'char-a', x: 0, z: 0 }, { id: 'char-b', x: 30, z: 0 }, { id: 'char-hidden', x: 0, z: 0, hidden: true }], objects: [] };
// A frame lit only in its middle columns: the centred character's box must land on them.
const frame = { width: 64, height: 36, data: new Uint8Array(64 * 36 * 4) };
for (let i = 0; i < 64 * 36; i++) frame.data.set(i % 64 >= 24 && i % 64 < 40 ? [200, 200, 200, 255] : [10, 10, 10, 255], i * 4);
const ports = { renderFrameBuffer: f => (assert.equal(f, 3), frame), bounds: ({ entity }) => ({ min: { x: entity.x - 0.3, y: 0, z: -0.2 }, max: { x: entity.x + 0.3, y: 1.8, z: 0.2 } }) };
const measured = lightingChecks([], state, ports);
assert.deepEqual({ ...measured, subjects: undefined }, { coverage: 'rendered-shot-frame', frame: 3, meanLuma: 0.225, clippedPct: 0, crushedPct: 0, subjects: undefined, look: { preset: 'studio', envLight: 0, ao: 0 } });
assert.deepEqual(measured.subjects.map(row => row.id), ['char-a', 'char-b'], 'visible characters by default');
assert.deepEqual(measured.subjects[0], { id: 'char-a', meanLuma: 0.784, contrast: 0 }, 'the 0.6 m wide box 3.8 m out lands on the lit middle columns (x 25..39)');
assert.deepEqual(measured.subjects[1], { id: 'char-b', meanLuma: null, contrast: null }, 'an off-frame character reads null');
assert.deepEqual(lightingChecks(['char-b'], state, ports).subjects.map(row => row.id), ['char-b'], 'named characters only');
assert.throws(() => lightingChecks(['char-a'], { ...state, camera: null }, { renderFrameBuffer: () => frame }), /shot camera/);
assert.throws(() => lightingChecks(['char-a'], state, { renderFrameBuffer: () => { throw new Error('busy'); }, bounds: () => null }), error => error.code === 'TARGET_NOT_READY');
console.log('PASS lighting measurement: frame luma, clipped/crushed share, subject boxes from the shot camera');

// Soft shadows: radius 1 keeps three's five-tap PCF; a wider radius averages sixteen taps.
assert.equal(installSoftShadows(), true, 'the PCF filter is patched (three still ships the expected five-tap block)');
const chunk = ShaderChunk.shadowmap_pars_fragment;
assert.ok(chunk.includes('if ( shadowRadius <= 1.0 )') && chunk.includes('vogelDiskSample( 4, 5, phi )') && chunk.includes('vogelDiskSample( i, 16, phi )'));
assert.equal(installSoftShadows(), true, 'installing twice is a no-op');
assert.equal(chunk, ShaderChunk.shadowmap_pars_fragment);
assert.equal(installSoftShadows({ shadowmap_pars_fragment: 'a filter of another three version' }), false, 'an unknown filter is left alone');
console.log('PASS soft shadows: five taps at radius 1, sixteen past it, idempotent');
