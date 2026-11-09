// The v4 engine's system prompt (motion only) and the scene brief that opens a conversation.
import { motionScene } from "../../../src/motion3/scene.js";

export const V4_SYSTEM_PROMPT = `You animate one character in CozyClay, a 3D previs studio. The user asks for a motion. Make it physically believable and easy to read from a side view and a front view.

Work like an animator who owns the rig and the camera:
1. Design the whole-body motion first. Write down the phases, the key poses, the timing in frames (24 fps), what supports the body in each phase (which hand or foot touches what), and the path of the centre of mass. In the air the COM follows a ballistic arc (g = 9.8 m/s^2); on the ground it stays over the support or the body moves to catch it. Plan anticipation, weight shifts and follow-through.
2. Build the motion in js with the rig library: key poses by FK rotations and by IK (hands and feet on targets, poles, joint limits), interpolation, contacts pinned while they hold, flight arcs. Write every bone on every frame with track. Move objects the character moves with object tracks.
3. Check the numbers with measure: penetration into the floor and objects, contacts and sliding, balance, joint limits, speed spikes.
4. Look with render: judge views (side and front, the way the viewer sees it), a tracking view, close-ups of hands and feet at contacts. Before each look, write 3 to 5 yes/no questions about what must be true in the picture, then answer them from the picture.
5. Fix what is wrong and look again. qa gives the old engine's opinion; treat it as hints, check them, never as a gate.
Finish when the motion reads right in the judge views and the numbers agree. Then say in 2 to 4 sentences what you made.

Units: metres, +Y up, floor at y = 0. The character faces +Z at yaw 0; +X is its left. Frames start at 0.
The installed take is what the user keeps: track commit installs it, and render commits a changed track by itself.`;

const BRIEF_MAX = 3000;
const num = value => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);
const vec = values => `[${(values ?? []).map(num).join(", ")}]`;

function installedLine(installed) {
	if (!installed || !Number.isFinite(installed.frames)) return "Installed take: none.";
	return `Installed take: ${installed.frames} frames (${installed.raw ? "a v4 raw track" : "an old-engine motion spec"}).`;
}

/**
 * sceneBrief({ character, sk, records, installed, frameCount }) -> plain text, at most 3,000 chars.
 * character: { id, model, position, yaw, scale? }; records: the authored scene records (motionScene input);
 * installed: { frames, raw } or null; frameCount: the timeline length.
 */
export function sceneBrief({ character, sk, records = [], installed = null, frameCount } = {}) {
	const byId = new Map(records.filter(Boolean).map(record => [record.id, record]));
	const scene = motionScene(records);
	const top = sk?.index?.HeadTop_End;
	const height = Number.isInteger(top) ? sk.restWorldPos[top][1] * (character?.scale ?? 1) : null;
	const head = [
		"Scene (metres, degrees; a record sits on its base pivot, the bottom centre; size is local; euler [rotX, rot, rotZ] means R = Rx * Ry * Rz).",
		`Subject: ${character?.id}, ${character?.model}, position ${vec(character?.position)}, yaw ${num(character?.yaw)}${height ? `, standing height ${num(height)} m (rest head top)` : ""}${character?.scale && character.scale !== 1 ? `, scale ${num(character.scale)} (a raw take installs only at scale 1)` : ""}, ${sk?.names?.length ?? 0} bones.`,
		installedLine(installed),
		`Timeline: ${Number.isFinite(frameCount) ? frameCount : "unknown"} frames at 24 fps.`,
	];
	const bodies = Object.entries(scene.objects).map(([id, box]) => {
		const record = byId.get(id) ?? {};
		return `- ${id}: ${box.renderer}, base ${vec(box.pos)}, size ${vec(box.half.map(h => h * 2))}, euler ${vec([record.rotX ?? 0, record.rot ?? 0, record.rotZ ?? 0])}${record.parent ? `, parent ${record.parent}` : ""}`;
	});
	const groups = Object.entries(scene.groups).map(([id, group]) => `- group ${id}: pivot ${vec(group.pos)}, parts ${group.children.join(", ")}`);
	const others = Object.entries(scene.others).filter(([id]) => !scene.groups[id]).map(([id, other]) => `${id} (${other.renderer})`);
	const rows = [...bodies, ...groups, ...(others.length ? [`- no body: ${others.join(", ")}`] : [])];
	const lines = [...head, rows.length ? `Objects (${bodies.length} ${bodies.length === 1 ? "body" : "bodies"}, ${groups.length} ${groups.length === 1 ? "group" : "groups"}):` : "Objects: none."];
	let size = lines.join("\n").length;
	for (const [index, row] of rows.entries()) {
		const tail = `... ${rows.length - index} more (all of them: rig.scene in js).`;
		if (size + row.length + tail.length + 2 > BRIEF_MAX) { lines.push(tail); break; }
		lines.push(row);
		size += row.length + 1;
	}
	return lines.join("\n");
}
