// What each tool's agent did in one run (docs/qa/physics-bench.md, PR 4): tool calls, failed calls, retries, result
// checks, and banned-tool use (plan 1.2). CozyClay: the Studio Agent's session JSONL files (main session and every
// task session it dispatched) plus the take it installed. Blender: Claude Code's stream-json output.
import { existsSync, readFileSync } from "node:fs";

const BANNED_SKILLS = ["flip", "hitReaction", "throwObject", "catchObject", "sitInSeat", "exitCar", "smokeCigarette"];
const BANNED_ACTIONS = ["motion.fill", "motion.primitive"];
// Blender: motion clips, other files' data, the network (calls, not mentions: bone names say "mixamorig" and comments
// may hold links). Re-importing the given FBX is not possible (the run user cannot read it), so an FBX or BVH import
// is a clip.
const BLENDER_BANNED = [
	["bvh import", /import_anim\.bvh/], ["fbx import", /import_scene\.fbx/],
	["library append/link", /wm\.(append|link)\(|libraries\.load\(|bpy\.ops\.asset\./],
	["network", /urllib\.request|urlopen\(|requests\.(get|post)\(|http\.client|socket\.create_connection\(/],
];

const lines = file => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const textOf = content => (Array.isArray(content) ? content.map(c => c.text ?? "").join("") : String(content ?? ""));
const CHECK = /verify|capture|screenshot|render|contact|frame_shot|thumbnail/i;

/** Banned skills or MotionBricks in a CozyClay spec (the installed one, or one inside a tool call). */
function specBans(spec, where) {
	const out = [];
	for (const u of spec?.use ?? []) if (BANNED_SKILLS.includes(u?.skill)) out.push({ rule: `skill ${u.skill}`, where });
	if (spec?.fill) out.push({ rule: "spec fill (MotionBricks)", where });
	return out;
}

/** Studio Agent sessions -> stats and bans. `files` are session .jsonl paths; `spec` the installed spec or null. */
export function cozyclayLog(files, spec) {
	const s = { modelCalls: 0, toolCalls: 0, failedCalls: 0, compiles: 0, resultChecks: 0, byTool: {}, banned: specBans(spec, "installed take") };
	for (const file of files) {
		const rows = lines(file).map(r => r.message).filter(Boolean);
		const results = new Map(rows.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m]));
		for (const m of rows.filter(m => m.role === "assistant")) {
			s.modelCalls++;
			for (const c of (m.content ?? []).filter(c => c.type === "toolCall")) {
				s.toolCalls++;
				s.byTool[c.name] = (s.byTool[c.name] ?? 0) + 1;
				const args = JSON.stringify(c.arguments ?? {}), res = results.get(c.id), text = textOf(res?.content);
				if (res?.isError || /"ok":\s*false/.test(text.slice(0, 400))) s.failedCalls++;
				s.compiles += (args.match(/motion\.compile/g) ?? []).length;
				if (CHECK.test(c.name) || /"(motion\.report|capture|verify)/.test(args)) s.resultChecks++;
				for (const a of BANNED_ACTIONS) if (args.includes(`"${a}"`)) s.banned.push({ rule: a, where: `${c.name} call` });
				for (const k of BANNED_SKILLS) if (new RegExp(`"skill"\\s*:\\s*"${k}"`).test(args)) s.banned.push({ rule: `skill ${k}`, where: `${c.name} call` });
				if (/"fill"\s*:\s*true/.test(args)) s.banned.push({ rule: "spec fill (MotionBricks)", where: `${c.name} call` });
			}
		}
	}
	s.retries = Math.max(0, s.compiles - 1);
	return s;
}

/** Claude Code stream-json -> stats, bans and the final result event. */
export function blenderLog(file) {
	const rows = lines(file), s = { modelCalls: 0, toolCalls: 0, failedCalls: 0, scriptRuns: 0, retries: 0, resultChecks: 0, byTool: {}, banned: [], result: null };
	const calls = new Map(), messages = new Set();
	let lastFailed = false;
	for (const r of rows) {
		if (r.type === "result") s.result = r;
		if (r.type === "assistant") {
			// stream-json sends one assistant event per content block: a model call is one message id
			messages.add(r.message?.id ?? messages.size);
			s.modelCalls = messages.size;
			for (const c of (r.message?.content ?? []).filter(c => c.type === "tool_use")) {
				const name = c.name.replace(/^mcp__blender__/, "");
				s.toolCalls++;
				s.byTool[name] = (s.byTool[name] ?? 0) + 1;
				calls.set(c.id, name);
				if (CHECK.test(name) || (name === "Read" && /\.(png|jpe?g|exr)$/i.test(c.input?.file_path ?? ""))) s.resultChecks++;
				if (/^execute_blender_code/.test(name)) {
					s.scriptRuns++;
					if (lastFailed) s.retries++;
					for (const [rule, re] of BLENDER_BANNED) if (re.test(c.input?.code ?? "")) s.banned.push({ rule, where: `${name} call` });
				}
			}
		}
		if (r.type === "user") {
			for (const c of (r.message?.content ?? []).filter(c => c?.type === "tool_result")) {
				const failed = Boolean(c.is_error) || /"status"\s*:\s*"error"|Traceback \(most recent call last\)/.test(textOf(c.content).slice(0, 4000));
				if (failed) s.failedCalls++;
				if (/^execute_blender_code/.test(calls.get(c.tool_use_id) ?? "")) lastFailed = failed;
			}
		}
	}
	return s;
}
