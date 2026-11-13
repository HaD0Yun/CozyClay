// What the poser calls a network: any object with `run(inputs) -> Promise<{ draft, rot6d }>`. The inputs come from
// encodeQuery (`val` [E*7], `weights` [E], `jointId`/`effType` BigInt64Array [E], `cond` [29]) with B = 1.

/** ONNX feeds for one query (the feed names are fixed by the model file); `Tensor` is the runtime's tensor class. */
function feedsFor(Tensor, inputs) {
	const E = inputs.weights.length;
	return {
		val: new Tensor("float32", inputs.val, [1, E, 7]),
		weights: new Tensor("float32", inputs.weights, [1, E]),
		joint_id: new Tensor("int64", inputs.jointId, [1, E]),
		eff_type: new Tensor("int64", inputs.effType, [1, E]),
		cond: new Tensor("float32", inputs.cond, [1, 29]),
	};
}

/** Wraps an onnxruntime session as a poser network; outputs are copied out of the runtime's buffers. */
export function sessionNetwork(session, Tensor) {
	return {
		async run(inputs) {
			const out = await session.run(feedsFor(Tensor, inputs));
			return { draft: Float32Array.from(out.draft.data), rot6d: Float32Array.from(out.rot6d.data) };
		},
		release: () => session.release?.(),
	};
}
