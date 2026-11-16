// A patch_elements call whose ops span domains (character, object, shot, stage), run by the sidecar as one
// patch_elements per domain instead of refused. The editor keeps one domain per command because a receipt
// asserts one revision step and one undo entry (studio-agent-protocol.js); the split keeps that, and its
// answer names every command, its op indices and its receipt or error, so the model sees what landed.

/** The ops grouped by target kind, in first-seen order; null when the ops stay in one domain. */
export function patchDomainGroups(args) {
	const ops = Array.isArray(args?.ops) ? args.ops : [];
	const groups = new Map();
	for (const [index, op] of ops.entries()) {
		const kind = op && typeof op === "object" ? op.target?.kind : undefined;
		if (typeof kind !== "string") return null;
		if (!groups.has(kind)) groups.set(kind, { kind, indices: [], ops: [] });
		groups.get(kind).indices.push(index);
		groups.get(kind).ops.push(op);
	}
	return groups.size > 1 ? [...groups.values()] : null;
}

/** `run(name, args, callId)` with a mixed patch_elements split by domain; every other call goes straight through. */
export function splitPatchByDomain(run) {
	return async (name, args, callId) => {
		const groups = name === "patch_elements" ? patchDomainGroups(args) : null;
		if (!groups) return run(name, args, callId);
		const commands = [];
		for (const group of groups) {
			try {
				commands.push({ kind: group.kind, opIndices: group.indices, receipt: await run(name, { ...args, ops: group.ops }, callId) });
			} catch (error) {
				commands.push({ kind: group.kind, opIndices: group.indices, error: { code: error?.code ?? "ERROR", message: String(error?.message ?? error) } });
			}
		}
		const failed = commands.filter(row => row.error);
		const note = `The ops spanned ${groups.length} domains (${groups.map(group => group.kind).join(", ")}), so they ran as ${groups.length} patch_elements commands, one per domain, each with its own receipt and undo entry; ${failed.length ? `${failed.length} refused (${failed.map(row => row.kind).join(", ")}), the others applied` : "all applied"}. opIndices are positions in your ops.`;
		if (failed.length === commands.length) throw Object.assign(new Error(`${note} ${failed.map(row => `${row.kind}: ${row.error.code}: ${row.error.message}`).join(" | ")}`.slice(0, 1800)), { code: failed[0].error.code });
		return { ok: true, splitByDomain: true, note, commands };
	};
}
