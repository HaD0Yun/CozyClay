// frame_shot's view of the whole shot, read from lenient compiles of its named subjects' installed takes.
// over: "shot" fits one camera to every pose of the shot; any other framing that holds the shot still says what it will miss.
import { compileSpec } from "../motion3/pipeline.js";
import { motionScene } from "../motion3/scene.js";
import { skeletonFor } from "../motion3/rigs/index.js";
import { fitHeld, heldIssues, placedOut } from "../motion3/shot-framing.js";
import { shotAtFrame } from "../cuts.js";
import { sampleContactSheetFrames } from "../studio-contact-sheet.js";
import { FRAMING_ANGLES, FRAMING_FRACTIONS, FRAMING_LEVELS } from "../studio-agent-commands.js";
import { focalMmToFov } from "../shot.js";
import { fail } from "./shared.js";

const SAMPLES = 24, FPS = 24;

function compiledTake(character, take, ports) {
	const sk = take?.schema === "cozyclay.take.v3" && take.spec ? skeletonFor(take.rig ?? character.model) : null;
	if (!sk) return null;
	try { return placedOut(compileSpec({ fps: FPS, ...take.spec }, { sk, scene: motionScene(ports.state().objects) }, { lenient: true }).out, take.placement, character); } catch { return null; }
}

function compiledSubjects(ids, raw, ports, requireAll) {
	const characters = ids.map(id => raw.characters.find(character => character.id === id));
	if (!characters.length || characters.some(character => !character)) return null;
	const candidates = characters.map(character => {
		const take = ports.storeDomain?.("motion")?.motionFor?.(character.id);
		return { character, take, out: compiledTake(character, take, ports) };
	});
	if (requireAll && candidates.some(part => !part.out?.frames.length)) return null;
	const parts = candidates.filter(part => part.out?.frames.length);
	if (!parts.length) return null;
	const outs = parts.map(part => part.out);
	const indexAt = (out, frame) => Math.max(0, Math.min(out.frames.length - 1, frame - (out.f0 ?? 0)));
	const frames = Array.from({ length: raw.frameCount }, (_, frame) => ({ s: { P: outs.flatMap(out => out.frames[indexAt(out, frame)].s.P) } }));
	const objectsAt = frame => {
		const objects = Object.entries(outs[0].ctx.objectsAt((outs[0].f0 ?? 0) + indexAt(outs[0], frame)));
		outs.forEach((out, index) => {
			const values = out.ctx.objectsAt((out.f0 ?? 0) + indexAt(out, frame));
			for (const id of Object.keys(parts[index].take.spec.objects ?? {})) objects.push([id, values[id]]);
		});
		return Object.fromEntries(objects);
	};
	return { characters: parts.map(part => part.character), out: { ...outs[0], f0: 0, frames, ctx: { ...outs[0].ctx, objectsAt } } };
}

const shotFrames = (shot, frameCount) => {
	const start = shot?.startFrame ?? 0, end = shot ? shot.endFrame + 1 : frameCount;
	return sampleContactSheetFrames({ startFrame: start, endFrameExclusive: end }, frameCount, SAMPLES);
};
const DEFAULT_FOCAL_MM = 35;
const lensOf = (raw, focalMm) => ({ tanV: Math.tan(focalMmToFov(focalMm ?? raw.camera?.focalMm ?? DEFAULT_FOCAL_MM, raw.filmback.sensorId, raw.filmback.aspectRatio) / 2), aspect: raw.filmback.aspectRatio });

/** args for owner().frame with over: "shot" resolved to an exact camera, and the report for checks.held. */
export function resolveOverShot(args, { raw, shots, ports }) {
	if (args.over !== "shot") return { args };
	const intent = args.framing?.intent;
	if (!intent) fail("INVALID_ARGUMENT", 'over: "shot" fits a camera to the framing intent; framing.exact already names one.');
	if (args.keyAtFrame !== undefined) fail("INVALID_ARGUMENT", 'over: "shot" holds one camera for the whole shot; keyAtFrame adds a key at one frame.');
	const { over: _, ...rest } = args, compiled = compiledSubjects(args.subjectIds, raw, ports, true), out = compiled?.out;
	if (!out) fail("TARGET_NOT_READY", 'over: "shot" reads every named subject\'s installed take; run motion.compile with install: true for each first, or frame one pose without over.');
	const character = compiled.characters[0];
	const shot = args.shotId ? shots.find(s => s.id === args.shotId) : shotAtFrame(shots, raw.view?.frame ?? 0), frames = shotFrames(shot, raw.frameCount);
	const lens = lensOf(raw, intent.focalMm), turn = (intent.side === "right" ? -1 : 1) * FRAMING_ANGLES[intent.view], asked = (character.rot ?? 0) + turn;
	const fit = fitHeld(out, frames, { asked, mirror: (character.rot ?? 0) - turn, fixedLens: intent.focalMm !== undefined, ...lens, fraction: FRAMING_FRACTIONS[intent.size], levelShare: FRAMING_LEVELS[intent.level] });
	if (!fit) fail("TARGET_NOT_READY", "The subject's take has no compiled frame in this shot.");
	const point = ([x, y, z]) => ({ x, y, z }), focalMm = Math.round((intent.focalMm ?? raw.camera?.focalMm ?? DEFAULT_FOCAL_MM) * fit.lensFactor);
	return { args: { ...rest, over: "shot", framing: { exact: { position: point(fit.eye), lookAt: point(fit.lookAt), focalMm } } },
		held: { frames, hidden: fit.hidden, outOfFrame: fit.outOfFrame, askedDeg: asked, chosenDeg: fit.chosen } };
}

/** { checks.held, warning } for a shot that now holds one camera: what it misses over the shot's frames. Nothing to say: {}. */
export function heldReport(plan, shot, { raw, ports, over }) {
	if (!over && (shot.cameraKeys?.length ?? 0) > 1) return {};
	const out = over ? null : compiledSubjects(plan.details.subjectIds, raw, ports, false)?.out;
	if (!out && !over) return {};
	const { framing } = plan.details, cam = { eye: [framing.pos.x, framing.pos.y, framing.pos.z], lookAt: lookOf(framing) };
	const frames = over?.frames ?? shotFrames(shot, raw.frameCount), { hidden, outOfFrame } = over ?? heldIssues(out, cam, frames, { tanV: Math.tan((framing.fovDeg * Math.PI) / 360), aspect: raw.filmback.aspectRatio });
	if (!over && !hidden.length && !outOfFrame.length) return {};
	const missing = hidden.length || outOfFrame.length;
	return { held: { frames, hidden, outOfFrame, ...(over ? { askedDeg: over.askedDeg, chosenDeg: over.chosenDeg } : {}) },
		...(missing ? { warning: { code: "HELD_SHOT", id: shot.id, message: `Held camera misses ${[hidden.length ? `${hidden.length} hidden` : "", outOfFrame.length ? `${outOfFrame.length} out of frame` : ""].filter(Boolean).join(", ")} of ${frames.length} sampled frames (checks.held).` } } : {}) };
}

const lookOf = ({ pos, yaw, pitch }) => [pos.x - Math.sin(yaw) * Math.cos(pitch), pos.y + Math.sin(pitch), pos.z - Math.cos(yaw) * Math.cos(pitch)];
