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
		return { ...splitReceipt(commands), splitByDomain: true, note, commands };
	};
}

/**
 * The receipt fields every consumer reads at the top level (the script's calls summary and rollback gate,
 * turnEdits, the task's receipts, the session transcript), folded over the commands that applied:
 * revision from the first one's before to the last one's after, the union of affectedIds, and the
 * refused domains as code/message with status "partial", so a script's calls summary names them too.
 */
function splitReceipt(commands) {
	const applied = commands.map(row => row.receipt).filter(Boolean), failed = commands.filter(row => row.error);
	const first = applied[0]?.revision, last = applied.at(-1)?.revision;
	const list = key => applied.flatMap(receipt => (Array.isArray(receipt[key]) ? receipt[key] : []));
	return {
		ok: true, status: failed.length ? "partial" : "applied",
		receiptId: applied.at(-1)?.receiptId ?? null, receiptIds: applied.map(receipt => receipt.receiptId ?? null),
		revision: first || last ? { before: first?.before ?? null, after: last?.after ?? null } : null,
		affectedIds: [...new Set(list("affectedIds"))],
		authored: applied.some(receipt => receipt.authored === true || (Number.isSafeInteger(receipt.revision?.after) && receipt.revision.after !== receipt.revision.before)),
		// delta and warnings stay in commands[].receipt only: a copy here would double them in the model's context
		summary: applied.map(receipt => receipt.summary).filter(text => typeof text === "string" && text).join(" "),
		...(failed.length ? { code: failed[0].error.code, message: `Refused: ${failed.map(row => `${row.kind} (ops ${row.opIndices.join(", ")}): ${row.error.code}: ${row.error.message}`).join(" | ")}`.slice(0, 900) } : {}),
	};
}
