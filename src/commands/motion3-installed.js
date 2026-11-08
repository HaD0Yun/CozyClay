// The installed take's QA, for install: "ifClean" (does a new take beat it?) and INSTALL_WORSE (did install: true replace a
// better one?). The spec store keeps the QA of every take this editor compiled, but it lives in the page's memory: a document
// reload empties it, and session eeff213e (deep-36 §4) then had 12 ifClean compiles in a row not installed, 6- and 5-problem
// takes among them, because a take whose QA was not stored never lost. Now such a take is measured once from its own spec on
// the current scene (as motion.qa measures an installed take) and its groups are kept in the store under its specId.
// Clean means 0 blocking problems (qa/blocking.js, #1114): a take with only warnings is clean, and one take beats another
// on its blocking groups (fewer, then fewer frame issues), so a take with warnings stays over one that blocks.
import { specIdOf } from "../motion3/spec-store.js";
import { installVerdict } from "../motion3/install-verdict.js";
import { blockingCount, blockingOf } from "../motion3/qa/blocking.js";

/**
 * createInstalledQa({ store, owner, compile }) -> { measure, verdict, worse }
 *   measure(character, scene) -> on | Promise<on>   on: { id, groups } (groups null when it cannot be measured), or null when no take is on
 *   verdict(on, qa) -> { wanted, note? }             ifClean: install a clean take (0 blocking), one that beats the installed take (fewer
 *                                                    blocking groups, then fewer of their frame issues), the first take, or any take
 *                                                    over an unmeasurable one
 *   worse(on, qa) -> note | null                     INSTALL_WORSE when install: true replaced a take with fewer blocking problems
 */
export function createInstalledQa({ store, owner, compile }) {
	const measure = (character, scene) => {
		const take = owner().motionFor(character.id);
		if (!take) return null;
		if (!take.spec) return { id: null, groups: null };
		const id = specIdOf(take.spec), kept = store.parts(id)?.groups;
		if (Array.isArray(kept)) return { id, groups: kept };
		const keep = r => { store.keepParts(id, { groups: r.qa.groups, timeline: r.timeline, probes: r.probes ?? {} }); return { id, groups: r.qa.groups }; };
		const lost = () => ({ id, groups: null });
		try {
			const r = compile(character, take.spec, {}, undefined, null, scene);
			return typeof r?.then === "function" ? r.then(keep, lost) : keep(r);
		} catch {
			return lost();
		}
	};
	const verdict = (on, qa) => (blockingCount(qa) === 0 || !on?.groups ? installVerdict(on, { ...qa, ok: blockingCount(qa) === 0 })
		: installVerdict({ groups: blockingOf(on.groups) }, { ok: false, groups: blockingOf(qa.groups ?? []) }));
	const worse = (on, qa) => {
		if (!on?.groups) return null;
		const before = blockingCount({ groups: on.groups, ok: on.groups.length === 0 }), now = blockingCount(qa);
		return before < now ? `INSTALL_WORSE: replaced the installed take ${on.id} (${before} blocking problem${before === 1 ? "" : "s"}) with this one (${now}); install: "ifClean" keeps the better take` : null;
	};
	return { measure, verdict, worse };
}
