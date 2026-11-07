// motion.compile's stop-rule counter: how many compiles in a row (per character and agent turn or task) did not lower QA problems below the best so far.
// The 90-run bench spent 36-42% of its rounds without improvement. The prompts stop after 4 such rounds when 4 or fewer problems
// remain, else after 8 (deep research 4: at a flat 2 every run stopped early and final QA rose to 13.4 groups against 4.3;
// deep research 10: reference sessions at 1-4 problems went 3.7 more rounds and 71% ended at 0, ours stopped after 0.7-1.6).
// A compile of a whole new spec (no base) counts like any other (#1116): it starts the count over only when it beats the best.
// The 2026-11-07 wall climb (r1-r3: 67/47/48 compiles, 15/15/29 whole specs, 9-23 problems at the end) used to start over at
// each whole spec; its sessions replayed, the 8-round stop comes at compile 9 of r1 (was 37) and 17 of r2 (was 20), and r3, which
// kept improving, still runs to its end. A new line, the agent turn or the Studio task the compile runs in (a worker task's
// compiles carry its taskId and no turnId: bin/agent/studio-turn-transaction.mjs), starts over; without either (MCP, tests) the
// count is per character.
const KEPT = 32;

export function createRoundWatch() {
	const lines = new Map();
	return (characterId, qa, line = null) => {
		const problems = qa?.problems ?? qa?.total ?? qa?.groups?.length ?? 0;
		const key = `${characterId}\u0000${line ?? ""}`, seen = lines.get(key);
		const next = !seen || problems < seen.best ? { best: problems, rounds: 0 } : { best: seen.best, rounds: seen.rounds + 1 };
		lines.delete(key);
		lines.set(key, next);
		// the newest KEPT lines (an older turn or task is over)
		if (lines.size > KEPT) lines.delete(lines.keys().next().value);
		return next.rounds;
	};
}
