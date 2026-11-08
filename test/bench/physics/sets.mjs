// Physical motion bench sets (docs/qa/physics-bench.md): read and check sets/*.json, convert a point to Blender
// axes, and write the request one tool's agent gets (task sentence + scene description + rules, plan 1.1 and 1.2).
// Set coordinates are CozyClay's: metres, +Y up, floor y = 0, the character faces +Z and +X is its left.
// Blender is +Z up with the imported Y Bot facing -Y, so a set point (x, y, z) is Blender (x, -z, y).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const SETS_DIR = join(HERE, "sets");
const RIG = JSON.parse(readFileSync(join(HERE, "../../../src/motion3/rigs/y-bot-tpose.json"), "utf8"));
const SHAPES = new Set(["box", "cylinder", "group"]);

const vec3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

function checkSet(set, file) {
	const bad = msg => { throw new Error(`${file}: ${msg}`); };
	if (set.version !== 0) bad(`version ${set.version}, expected 0`);
	if (set.fps !== 24) bad("fps must be 24");
	if (!set.request?.ko || !set.request?.en) bad("request needs ko and en");
	if (set.character?.rig !== "y-bot-tpose" || set.character?.facing !== "+Z" || !vec3(set.character.position)) bad("character must be a Y Bot facing +Z with a position");
	const ids = new Set();
	for (const o of set.objects) {
		if (!/^[a-z0-9-]+$/.test(o.id) || ids.has(o.id)) bad(`object id "${o.id}" is not unique kebab-case`);
		ids.add(o.id);
		if (!SHAPES.has(o.shape) || !vec3(o.center)) bad(`${o.id}: shape or center`);
		if (o.shape !== "group" && (!vec3(o.size) || o.size.some(v => v <= 0))) bad(`${o.id}: size`);
		if (o.shape === "cylinder" && !["x", "y", "z"].includes(o.axis)) bad(`${o.id}: cylinder axis`);
		if (o.parent && set.objects.find(p => p.id === o.parent)?.shape !== "group") bad(`${o.id}: parent ${o.parent} is not a group`);
		if (o.fixed && o.mass != null) bad(`${o.id}: a fixed object has no mass`);
	}
	return set;
}

/** Every set, in task order, or the ones whose id or task number is listed. */
export function loadSets(only = []) {
	const files = readdirSync(SETS_DIR).filter(f => f.endsWith(".json")).sort();
	const sets = files.map(f => checkSet(JSON.parse(readFileSync(join(SETS_DIR, f), "utf8")), f));
	const want = only.map(String);
	const unknown = want.filter(w => !sets.some(s => s.id === w || String(s.task) === w));
	if (unknown.length) throw new Error(`no physics set matches: ${unknown.join(", ")}`);
	return want.length ? sets.filter(s => want.includes(s.id) || want.includes(String(s.task))) : sets;
}

/** A set point (CozyClay axes) in Blender axes. */
const toBlender = ([x, y, z]) => [x, -z, y];

const num = v => String(Math.round(v * 1000) / 1000);
const pt = v => `(${v.map(num).join(", ")})`;
const AXIS = { cozyclay: { x: "X", y: "Y", z: "Z" }, blender: { x: "X", y: "Z", z: "Y" } };

function objectLine(o, tool, set) {
	const p = tool === "blender" ? toBlender(o.center) : o.center;
	const name = `${o.id} ("${o.name}")`;
	if (o.shape === "group") {
		const kids = set.objects.filter(k => k.parent === o.id).map(k => k.id).join(", ");
		return `- ${name}: 빈 부모 묶음, 기준점 ${pt(p)}, 자식 ${kids}. 묶음 전체 질량 ${o.mass} kg, 움직일 수 있음.`;
	}
	const [sx, sy, sz] = o.size;
	const dims = tool === "blender" ? `X ${num(sx)} × Y ${num(sz)} × Z ${num(sy)}` : `X ${num(sx)} × Y ${num(sy)} × Z ${num(sz)}`;
	const body = o.shape === "box"
		? `상자, 중심 ${pt(p)}, 크기 ${dims}`
		: `원기둥, 축 ${AXIS[tool][o.axis]}, 중심 ${pt(p)}, 길이 ${num(o.axis === "x" ? sx : o.axis === "y" ? sy : sz)}, 지름 ${num(o.axis === "x" ? sy : sx)}`;
	const what = o.fixed ? "고정 (움직이지 않음)" : o.parent ? `${o.parent} 묶음의 일부` : `질량 ${o.mass} kg, 움직일 수 있음`;
	return `- ${name}: ${body}. ${what}.`;
}

function characterLine(set, tool) {
	const c = set.character;
	if (tool === "cozyclay") return `- 캐릭터 ${c.id}: Y Bot (y-bot-tpose), 발 기준점 ${pt(c.position)}, +Z를 보고 서 있음.`;
	const bones = RIG.bones.map(b => `mixamorig:${b.name}`).join(", ");
	return [`- 캐릭터: armature 오브젝트 ${c.id} (Mixamo Y Bot FBX, 메시 Alpha_Surface와 Alpha_Joints가 붙어 있음), 원점 ${pt(toBlender(c.position))}, -Y를 보고 있음, 지금은 T 포즈.`,
		`- 뼈 ${RIG.bones.length}개: ${bones}.`].join("\n");
}

const FRAME = {
	cozyclay: "단위는 m, kg, 초. Y가 위, 바닥은 y = 0. 캐릭터의 정면은 +Z, 캐릭터의 왼쪽은 +X.",
	blender: "단위는 m, kg, 초. Z가 위, 바닥(floor 오브젝트)은 z = 0. 캐릭터의 정면은 -Y, 캐릭터의 왼쪽은 +X. 장면은 24 fps.",
};
const RULES = {
	cozyclay: [
		"- 미리 만든 동작은 쓰지 마. 스킬 flip, hitReaction, throwObject, catchObject, sitInSeat, exitCar, smokeCigarette와 MotionBricks 경로 전부(motion.fill, motion.primitive, Smart Primitive 도구)는 금지다.",
		"- 키, 앵커, IK, 컴파일러 자동 규칙, walkTo, reachGrip, standIdle, QA, range 탐색은 써도 된다.",
		"- 결과는 char-a의 모션 테이크로 남겨. 컨택트 시트와 캡처로 직접 확인해도 된다.",
	],
	blender: [
		"- 미리 만든 동작은 쓰지 마. Mixamo 애니메이션, BVH·FBX 동작 클립, 외부 모캡, 애셋 라이브러리의 동작은 금지다.",
		"- bpy, IK 제약, 드라이버, 리지드 바디 물리, Rigify 같은 내장 리그 도구는 써도 된다.",
		"- 결과는 지금 열린 Blender 장면에 char-a armature의 애니메이션으로 남겨. 물체가 움직이면 그 물체도 애니메이션으로 남겨. 파일로 저장하지 않아도 된다. 렌더와 스크린샷으로 직접 확인해도 된다.",
	],
};

/** The one message a run sends (plan 1.1): task sentence, scene description, rules. Korean (the bench language). */
export function requestText(set, tool) {
	if (!FRAME[tool]) throw new Error(`unknown tool ${tool}`);
	const scene = [FRAME[tool], characterLine(set, tool), ...set.objects.map(o => objectLine(o, tool, set)),
		`- 동작 길이는 자유, 최대 ${set.maxSeconds}초 (24 fps).`];
	const rules = [...RULES[tool], "- 사람은 중간에 답하지 않는다. 끝나면 무엇을 했는지 한 문단으로 답해."];
	return `${set.request.ko}\n\n[장면]\n${scene.join("\n")}\n\n[규칙]\n${rules.join("\n")}\n`;
}
