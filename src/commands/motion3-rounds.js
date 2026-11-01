// motion.compile's stop-rule counter: how many compiles in a row (per character) did not lower QA problems below the best so far.
// The 90-run bench spent 36-42% of its rounds without improvement. The prompts stop after 4 such rounds when 4 or fewer problems
// remain, else after 8 (deep research 4: at a flat 2 every run stopped early and final QA rose to 13.4 groups against 4.3;
// deep research 10: reference sessions at 1-4 problems went 3.7 more rounds and 71% ended at 0, ours stopped after 0.7-1.6).
// A compile of a whole new spec (no base) starts the count over.
export function createRoundWatch() {
	const byCharacter = new Map();
	return (characterId, qa, fresh) => {
		const problems = qa?.problems ?? qa?.total ?? qa?.groups?.length ?? 0;
		const seen = fresh ? null : byCharacter.get(characterId);
		const next = !seen || problems < seen.best ? { best: problems, rounds: 0 } : { best: seen.best, rounds: seen.rounds + 1 };
		byCharacter.set(characterId, next);
		return next.rounds;
	};
}
