// The look after a sculpt: a run_action object.sculpt the model called itself (not one inside a script) answers with
// a verify_result closeup of that object attached as an image, so the model sees what it built without asking.
// A failed look never fails the sculpt: the receipt goes back with look.status "unavailable" and why.

/** The sculpted object's id when this call earns a look, else null. call.toolCallId marks the model's own call; a script's nested calls carry only callId. */
export function sculptLookTarget(name, args, call, result) {
	if (name !== "run_action" || args?.action !== "object.sculpt" || !call?.toolCallId) return null;
	if (!result || typeof result !== "object" || result.ok === false || result.dataUrl) return null;
	const id = args.args?.id ?? result.affectedIds?.[0];
	return typeof id === "string" && id ? id : null;
}

// The editor draws a sculpt on its next render after the receipt, so the first look can find it not drawn yet
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

/** result with the closeup attached (dataUrl, which the runner sends as image content) and a look summary. */
export async function withSculptLook(name, args, call, result, { invoke, resolveImage, wait = DRAW_WAIT_MS }) {
	const id = sculptLookTarget(name, args, call, result);
	if (!id) return result;
	try {
		const seen = await drawnLook(() => invoke("verify_result", { targets: [id], checks: ["placement"], visual: "closeup" }, call.toolCallId), wait), ref = seen?.visualRefs?.[0];
		const image = ref?.imageId ? await resolveImage(ref.imageId, { receiptId: seen.receiptId, revision: seen.revision }) : null;
		if (!image?.dataUrl) return { ...result, look: { status: "unavailable", reason: image?.reason ?? "the closeup had no image" } };
		const floating = seen.checks?.placement?.unsupportedIds ?? [];
		return { ...result, dataUrl: image.dataUrl, look: { status: "attached", visual: "closeup", imageId: ref.imageId, views: ref.views, bounds: ref.bounds, figure: ref.figure, ...(floating.length ? { floating } : {}) } };
	} catch (error) {
		return { ...result, look: { status: "unavailable", reason: `${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}` } };
	}
}
