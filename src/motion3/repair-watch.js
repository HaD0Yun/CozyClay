// The stop rule of the compile-repair loop (motion.compile): a short note in the answer when more
// compiles stopped paying. It never refuses a compile; the agent reads output.stuck and the prompt
// tells it to obey. The agent's own logs set the numbers: a compile is ~0.3 s but a repair step is
// ~1,250 output tokens of model time, a turn compiles median 8 / p90 17 times, a failure that survives
// two retries unchanged survives a third about a third of the time, and about a fifth of the
// compiles after a take first passes QA failed QA again (re-tweaking what already passed).
//   polish  an earlier compile of this character in this turn passed QA: say so; stop only when the visible criteria
//           and verify_result's physics review pass too, else keep fixing: past QA 0 a round improves when a fault
//           shrinks (output.noImprovementRounds counts QA only), and the take nearest the criteria wins (#1114)
//   cap     REPAIR_CAP compiles after the first: report what still fails on the best take
//   stuck   the same failing groups (or more) for STUCK_AFTER compiles in a row, neither fewer nor
//           DELTA_STEP less severe: stop patching them (or re-applying their hints), start over,
//           take another approach, or report what the best take still fails
// History is per character and agent turn (context.turnId); without a turn (MCP, tests) per character,
// with the cap counted along the base chain (a whole spec starts it again). In a turn the cap counts agent
// steps: the compiles of one tool call (context.callId; a script's nested ones share the script's) are one
// repair step, as a script that compares variants is one try; a compile with no call id is a step of its own.
// The 60 bench sessions: compiles counted one by one read 10-23 at the agent's 6-12th compiling call. The stuck streak
// counts the same steps: of the runs of 3 script compiles whose problems and issues did not drop (the SSE frames), 21 of
// 37 merged (48 of 71 base) lay inside one script, which compared variants; each step's last compile carries it on. A whole spec sent after a
// stuck note is the fresh start the note asked for, so the streak starts again too.
// A note never leaves the take empty: the agent obeys it by reporting, and a turn whose compiles all ran
// install: "ifClean" (or false) unclean ended with no take (5 of 30 bench runs). So the line keeps its best
// compile per placement (`at`, the last PLACES of them: a take plays in the character's placement frame,
// take.js, so it only meets the scene where it was baked) with its take, and a note on a compile that did
// not install itself answers `install`: the best take here, when the character carries no take or one the
// watch put on that this one beats. The caller installs it (no compile: the take is the one baked then).
// A take the agent installed (install: true, or an ifClean that installed) is never replaced for the rest
// of the line, nor one the character had before it (replay of merged r3 S8: the agent's own take was
// swapped for an earlier draft, so its report no longer named the character's take).
import { groupKey } from "./qa/severity.js";

const STUCK_AFTER = 3;
const REPAIR_CAP = 10;
const DELTA_STEP = 0.05;
const KEPT = 32;
// lines whose best takes are kept (the newest): a take is ~0.25 MB a 240-frame Y Bot take (rotations, 65 bones), so
// with PLACES each at most about 3 MB here; an older line keeps its notes but no take (its turn is over)
const TAKES = 4;
// placements per line whose best take is kept (S8 r1 moved the body 0.78 -> 0.88 -> 0.94 -> 0.88 m)
const PLACES = 3;
const SAY_CODES = 2;

const severity = groups => groups.reduce((s, g) => s + (Number.isFinite(g.severity) ? g.severity : 0), 0);
const superset = (a, b) => [...b].every(k => a.has(k));
const better = (a, b) => (a.ok !== b.ok ? a.ok : a.n !== b.n ? a.n < b.n : a.sev < b.sev);
const problems = n => `${n} problem${n === 1 ? "" : "s"}`;
const cut = s => (s.length > 40 ? `${s.slice(0, 39)}~` : s);
const named = c => `${c.specId} (${c.ok ? "QA passes" : problems(c.n)})`;
// a take plays in the character's placement frame: one the watch put on says so (a move misaligns it)
const POS = "bound to this position (recompile after a move)";

export function createRepairWatch() {
	const lines = new Map();
	const lineOf = key => {
		let line = lines.get(key);
		if (line) { lines.delete(key); lines.set(key, line); return line; }
		// picks: the best compile per placement; held: the take the watch put on; mine: the agent's own last install
		line = { compiles: 0, steps: 0, call: null, last: null, before: null, passed: null, best: null, picks: new Map(), held: null, mine: null, noted: false, depth: new Map() };
		lines.set(key, line);
		if (lines.size > KEPT) lines.delete(lines.keys().next().value);
		return line;
	};
	/**
	 * One compile's note. qa is the full QA (every group); base the specId it patched, absent for a whole
	 * spec; at the placement key of the compile (character pose and scene), take its baked take (kept while
	 * it is the best at `at`), installed whether this compile put its own take on the character, current the
	 * specId of the take the character carries now (after this compile).
	 * -> { say?, install?: { specId, take } } : install is the best take the caller puts on the character.
	 * callId the agent's tool call the compile ran in, or null.
	 * @param {{ characterId: string, turnId?: string | null, callId?: string | null, specId: string, base?: string, qa: { ok: boolean, groups: object[] },
	 *   at?: string, take?: unknown, installed?: boolean, current?: string | null }} c
	 */
	function note({ characterId, turnId = null, callId = null, specId, base, qa, at = "", take, installed = false, current = null }) {
		const line = lineOf(`${characterId}\u0000${turnId ?? ""}`), groups = qa.groups ?? [];
		const now = { specId, at, ok: Boolean(qa.ok), fails: new Set(groups.map(groupKey)), n: groups.length, sev: severity(groups), streak: 1 };
		// core: the failures the whole streak shares (its first compile's; the later ones hold them all)
		now.core = now.fails;
		// a step: one agent call (its compiles share callId) or one compile; the streak compares with the last compile of the
		// step before, so the variants one script compares are one try, not three
		const step = !callId || callId !== line.call;
		if (step) line.before = line.last;
		const prev = line.before, fresh = base === undefined && line.noted;
		if (prev && !fresh && now.fails.size && prev.fails.size && superset(now.fails, prev.fails) && now.n >= prev.n && now.sev > prev.sev * (1 - DELTA_STEP))
			Object.assign(now, { streak: prev.streak + 1, core: prev.core });
		line.compiles += 1;
		if (step) line.steps += 1;
		line.call = callId;
		const depth = base === undefined ? 0 : (line.depth.get(base) ?? 0) + 1;
		line.depth.set(specId, depth);
		const repairs = turnId ? line.steps - 1 : depth, passed = line.passed, best = line.best;
		line.last = now;
		if (now.ok && !line.passed) line.passed = specId;
		if (!best || better(now, best)) line.best = now;
		// the best take at this placement (each of the last PLACES keeps its own), and the agent's own install
		let pick = line.picks.get(at);
		if (!pick || better(now, pick)) {
			pick = { ...now, take };
			let older = lines.size - TAKES;
			for (const other of lines.values()) if (older-- > 0) for (const p of other.picks.values()) p.take = undefined;
		}
		line.picks.delete(at);
		line.picks.set(at, pick);
		if (line.picks.size > PLACES) line.picks.delete(line.picks.keys().next().value);
		if (installed) line.mine = now;
		const past = c => (best && best.specId !== c.specId && better(best, c) ? `; best so far ${named(best)}` : "");
		const kind = passed && passed !== specId ? "polish" : repairs >= REPAIR_CAP && !now.ok ? "cap" : now.streak >= STUCK_AFTER ? "stuck" : null;
		line.noted = Boolean(kind) && !passed;
		if (!kind) return {};
		// the take to leave on the character: this compile's, or the agent's own, when it carries it; else fill an empty
		// take, or upgrade the one the watch put on, with the best here; a take from before this line stays
		const held = line.held, mine = line.mine && line.mine.specId === current, watched = held && held.specId === current;
		const keeps = !installed && !mine && watched && held.at === at && !better(pick, held);
		const fills = !installed && !mine && !keeps && (current === null || watched) && pick.take !== undefined;
		const install = fills ? { specId: pick.specId, take: pick.take } : undefined;
		if (install) line.held = pick;
		// what the character carries after the note, in one sentence; then what to do (a cap note at most ~180 characters)
		const status = installed ? `This take is installed${past(now)}.` : install ? `Installed the best take here, ${named(pick)}, ${POS}.`
			: mine ? `Your installed take ${named(line.mine)} stays${past(line.mine)}.` : keeps ? `${named(held)} stays installed, ${POS}.`
				: current !== null && pick.take !== undefined ? `The earlier take stays; to replace it, install the best take here, ${named(pick)}.`
					: `Install the best take here, ${named(pick)}.`;
		// QA 0 is not done (#1114): the visible criteria and verify_result's support/contact/penetration review decide too;
		// handstand r3 kept a QA-clean take with fingers 18 cm deep over a QA 1 variant at 4.3 cm, so a smaller fault is the
		// improvement and a QA 1 take may be the best one (install: true)
		const asked = "stop only when every visible criterion is met and verify_result shows no support, contact or skin penetration fault past tolerance. Else keep fixing, install: true to verify each try (INSTALL_WORSE is expected): noImprovementRounds counts QA only, so a round improves when a fault or unmet criterion shrinks, and the best take is the one nearest the criteria, then with the fewest QA problems";
		let say;
		if (kind === "polish") say = !install ? `${passed} already passed QA: ${asked}.` : install.specId === passed ? `${passed} passed QA and is now installed, ${POS}: ${asked}.`
			: `${passed} passed QA at another position; the best take here, ${named(pick)}, is installed, ${POS}. Report its problems; ${asked}.`;
		else if (kind === "cap") say = `${repairs} repair ${turnId && callId ? "calls" : "compiles"}. ${status} Report its problems; stop unless asked for more.`;
		else {
			const codes = [...now.core], names = codes.slice(0, SAY_CODES).map(cut).join(", ") + (codes.length > SAY_CODES ? ` +${codes.length - SAY_CODES}` : "");
			say = `${names} unchanged over ${now.streak} ${turnId && callId ? "calls" : "compiles"}. Stop patching it or re-applying its hint: start afresh or try another approach. ${status} If neither helps, report its problems.`;
		}
		return { say, ...(kind === "polish" ? { polish: true } : {}), ...(install ? { install } : {}) };
	}
	return { note };
}
