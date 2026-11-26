// The look after an action: an action whose declaration names a look (src/studio-actions.js `look`, carried in the
// turn's action index) answers a run_action call, the model's own or one inside a script, with that verify_result
// visual of what it changed attached as an image, so the model sees what it made without asking. A script carries
// the pictures of its nested calls back (script-tool.mjs).
// A failed look never fails the action: the receipt goes back with look.status "unavailable" and why.

/**
 * The id the look frames when this call earns one, else null. lookOf(actionId): the declared look of that action.
 * call: a model's call carries its toolCallId, a script's nested call the script's as callId; a call with neither
 * (main-agent.mjs quick_edit) gets no look.
 */
export function lookTarget(name, args, call, result, lookOf) {
	if (name !== "run_action" || !lookOf(args?.action) || !(call?.toolCallId || call?.callId)) return null;
	if (!result || typeof result !== "object" || result.ok === false || result.dataUrl) return null;
	const id = args.args?.id ?? result.affectedIds?.[0];
	return typeof id === "string" && id ? id : null;
}

// The editor draws a change on its next render after the receipt, so the first look can find it not drawn yet
// (TARGET_NOT_READY): asked again every DRAW_WAIT_MS, at most DRAW_TRIES times (estimate: a 39-part sculpt drew in < 1 s).
const DRAW_WAIT_MS = 250, DRAW_TRIES = 12;
async function drawnLook(look, wait) {
	for (let attempt = 1; ; attempt++) {
		try { return await look(); } catch (error) {
			if (error?.code !== "TARGET_NOT_READY" || attempt >= DRAW_TRIES) throw error;
			await new Promise(resolve => setTimeout(resolve, wait));
		}
	}
}

/** result with the look attached (dataUrl, which the runner sends as image content) and a look summary. */
export async function withActionLook(name, args, call, result, { invoke, resolveImage, lookOf = () => null, wait = DRAW_WAIT_MS }) {
	const id = lookTarget(name, args, call, result, lookOf);
	if (!id) return result;
	const visual = lookOf(args.action), callId = call?.callId ?? call?.toolCallId;
	try {
		const seen = await drawnLook(() => invoke("verify_result", { targets: [id], checks: ["placement"], visual }, callId), wait), ref = seen?.visualRefs?.[0];
		const image = ref?.imageId ? await resolveImage(ref.imageId, { receiptId: seen.receiptId, revision: seen.revision }) : null;
		if (!image?.dataUrl) return { ...result, look: { status: "unavailable", reason: image?.reason ?? `the ${visual} had no image` } };
		const floating = seen.checks?.placement?.unsupportedIds ?? [];
		return { ...result, dataUrl: image.dataUrl, look: { status: "attached", visual, imageId: ref.imageId, views: ref.views, bounds: ref.bounds, figure: ref.figure, ...(floating.length ? { floating } : {}) } };
	} catch (error) {
		return { ...result, look: { status: "unavailable", reason: `${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}` } };
	}
}
