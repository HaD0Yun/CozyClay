import { inspectH3Output } from "./h3-preservation.mjs";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const COMFY_DEFAULT_WIDTH = 1024;
const COMFY_DEFAULT_HEIGHT = 576;
const MAX_INLINE_VIDEO = 24 * 1024 * 1024;

import { DEFAULT_FAL_VIDEO_MODEL, falVideoContract } from "./fal-contract.mjs";

export function validateFalVideoRequest({ model, durationSeconds, aspect }) {
	const contract = falVideoContract(model);
	if (!contract.aspectFromImage && !contract.aspects.includes(aspect)) throw Object.assign(new Error(`Fal model ${model} does not support aspect ratio ${aspect}.`), { code: "fal-invalid-request" });
	if (!Number.isFinite(Number(durationSeconds)) || Number(durationSeconds) < contract.minDuration || Number(durationSeconds) > contract.maxDuration || (contract.integerDuration && !Number.isInteger(Number(durationSeconds)))) {
		throw Object.assign(new Error(`Fal model ${model} supports ${contract.minDuration}-${contract.maxDuration} second${contract.integerDuration ? " integer-duration" : ""} videos.`), { code: "fal-invalid-request" });
	}
	return contract;
}

async function probeVideoBytes(bytes) {
	const directory = await mkdtemp(join(tmpdir(), "cozyclay-fal-video-"));
	const filename = join(directory, "output.mp4");
	try {
		await writeFile(filename, bytes);
		const { stdout } = await execFile("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,duration:format=duration", "-of", "json", filename]);
		const report = JSON.parse(stdout);
		const stream = report.streams?.[0] || {};
		const [numerator, denominator] = String(stream.r_frame_rate || "0/1").split("/").map(Number);
		const fps = denominator > 0 ? numerator / denominator : NaN;
		const seconds = Number(stream.duration ?? report.format?.duration);
		if (!Number.isFinite(Number(stream.width)) || !Number.isFinite(Number(stream.height)) || !Number.isFinite(fps) || !Number.isFinite(seconds)) throw new Error("Fal video metadata is incomplete.");
		return { width: Number(stream.width), height: Number(stream.height), fps, seconds, metadataMeasured: true };
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

export function comfyDimensionsForAspect(aspect) {
	if (aspect === "9:16") return { width: 576, height: 1024 };
	if (aspect === "1:1") return { width: 768, height: 768 };
	// H3's latent canvas is quantized to 32-pixel axes; 1024x598 is not a
	// valid canvas and makes MiniMaxH3ImageToVideo reject the graph.  1312x768
	// is the nearest valid 12:7 canvas under H3's 768-short-edge pixel cap.
	if (aspect === "12:7") return { width: 1312, height: 768 };
	// Keep every axis on H3's 32-pixel latent grid. These are the closest
	// representable canvases to the requested cinematic ratios.
	if (aspect === "2.39:1") return { width: 1152, height: 480 };
	if (aspect === "21:9") return { width: 1120, height: 480 };
	if (aspect === "4:3") return { width: 768, height: 576 };
	return { width: COMFY_DEFAULT_WIDTH, height: COMFY_DEFAULT_HEIGHT };
}

// MiniMax H3 is conditioned on the uploaded first frame, but the model is
// still free to invent a new set or camera unless the contract is repeated in
// every request. Keep this wording positive and structural: mentioning things
// such as windows or curtains in a negative prompt has repeatedly caused H3 to
// hallucinate those objects into the set.
export const H3_PRESERVATION_CONTRACT =
	"Treat the provided first image as an immutable scene plate for the entire video. Keep the exact background, floor, set geometry, lighting, horizon, lens, viewpoint, framing, and object positions unchanged from the first frame through the last frame. Animate only the foreground human subject. Use one continuous shot with a locked camera: no pan, tilt, orbit, dolly, zoom, crop, reframing, cut, transition, or time jump. Preserve all non-subject pixels and keep the subject's silhouette edges sharp. Motion priority: honor the requested subject action, including climbing, sitting, hanging, jumping, or any other vertical movement; never flatten that movement or force the subject to remain on the floor. This subject-motion rule changes only the performer, never the scene plate or camera.";

export function isH3Workflow(workflow) {
	let found = false;
	const walk = (value) => {
		if (found || !value || typeof value !== "object") return;
		if (typeof value.class_type === "string" && /minimax.?h3|h3.*video/i.test(value.class_type)) found = true;
		for (const [key, child] of Object.entries(value)) {
			if (key !== "prompt" && typeof child === "string" && /minimax.?h3|h3.*video/i.test(child)) found = true;
			else if (key !== "prompt") walk(child);
		}
	};
	walk(workflow);
	return found;
}

export function buildH3LockedPrompt(prompt) {
	const source = String(prompt ?? "").trim();
	if (!source) return H3_PRESERVATION_CONTRACT;
	if (source.includes("immutable scene plate for the entire video")) return source;
	return `${source}\n\n${H3_PRESERVATION_CONTRACT}`;
}

/** A Comfy API link is [node id, output index]. A truthy value in
 * `first_frame` is not enough: a stale graph can point H3 at an empty latent
 * or another generated image while a separate LoadImage node sits unused.
 * Follow the link back to the LoadImage node that the adapter will rewrite to
 * the uploaded clay frame. This makes the upload and the H3 condition one
 * connected path, like checking that a film reel is actually threaded through
 * the projector rather than merely present on the desk. */
function hasFirstFrameCondition(workflow) {
	if (!isH3Workflow(workflow)) return true;
	const nodes = workflow && typeof workflow === "object" ? workflow : {};
	const refId = (value) => Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
	const reachesLoadImage = (id, visiting = new Set()) => {
		if (!id || visiting.has(id)) return false;
		const node = nodes[id];
		if (!node || typeof node !== "object") return false;
		if (/loadimage/i.test(String(node.class_type || "")) && typeof node.inputs?.image === "string" && node.inputs.image.trim()) return true;
		// Keep each link traversal independent. A dead branch must not mark a
		// shared node as visited and hide a later valid path to LoadImage.
		const nextVisiting = new Set(visiting);
		nextVisiting.add(id);
		return Object.values(node.inputs || {}).some((value) => reachesLoadImage(refId(value), nextVisiting));
	};
	return Object.values(nodes).some((node) => {
		if (!node || typeof node !== "object" || !/minimax.?h3|h3.*video/i.test(String(node.class_type || ""))) return false;
		const value = (node.inputs || {}).first_frame ?? (node.inputs || {}).image;
		return reachesLoadImage(refId(value));
	});
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) return reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
	const timer = setTimeout(resolve, ms);
	const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); };
	signal?.addEventListener("abort", abort, { once: true });
});

function jsonResponse(response) {
	if (!response.ok) throw new Error(`Video provider responded ${response.status}`);
	return response.json();
}

function dataUrlBlob(dataUrl) {
	const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl || "");
	if (!match) throw new Error("Image must be a base64 data URL.");
	return new Blob([Buffer.from(match[2], "base64")], { type: match[1] });
}

function findDimensions(value, fallbackWidth, fallbackHeight) {
	let width = fallbackWidth; let height = fallbackHeight; let seconds;
	const walk = (item) => {
		if (!item || typeof item !== "object") return;
		if (Number.isFinite(item.width)) width = Number(item.width);
		if (Number.isFinite(item.height)) height = Number(item.height);
		if (Number.isFinite(item.duration)) seconds = Number(item.duration);
		for (const child of Object.values(item)) if (child && typeof child === "object") walk(child);
	};
	walk(value);
	return { width, height, seconds };
}

function preferredVideoOutputNodes(workflow) {
	return new Set(Object.entries(workflow || {})
		.filter(([, node]) => /savevideo|videocombine|videooutput/i.test(String(node?.class_type || "")))
		.map(([id]) => id));
}

const isH3Node = (node) => /minimax.?h3|h3.*video/i.test(String(node?.class_type || ""));
const isLoadImageNode = (node) => /loadimage/i.test(String(node?.class_type || ""));
const isCompositeNode = (node) => /imagecomposite|compositeimage|imagemattecomposite/i.test(String(node?.class_type || ""));

function h3GuardError(message, reason) {
	return Object.assign(new Error(message), {
		code: "h3-preservation-failed",
		preservation: { pass: false, reason },
	});
}

function linkedNodeIds(value, result = []) {
	if (Array.isArray(value)) {
		if (typeof value[0] === "string") result.push(value[0]);
		else for (const child of value) linkedNodeIds(child, result);
	} else if (value && typeof value === "object") {
		for (const child of Object.values(value)) linkedNodeIds(child, result);
	}
	return result;
}

function reachesNode(nodes, startId, predicate, visiting = new Set()) {
	if (!startId || visiting.has(startId)) return false;
	const node = nodes?.[startId];
	if (!node || typeof node !== "object") return false;
	if (predicate(node)) return true;
	const nextVisiting = new Set(visiting);
	nextVisiting.add(startId);
	return Object.values(node.inputs || {}).some((value) => linkedNodeIds(value).some((id) => reachesNode(nodes, id, predicate, nextVisiting)));
}

/**
 * H3 itself is an image-to-video sampler and cannot guarantee that generated
 * pixels outside the performer stay unchanged. A valid production graph must
 * therefore composite the generated subject over the uploaded plate before
 * its final video writer. Keep this structural check alongside the pixel
 * validator: the pixel check catches a bad run, while this check prevents a
 * graph with no deterministic preservation stage from running at all.
 */
export function hasH3SceneComposite(workflow, outputNodeIds) {
	const nodes = workflow && typeof workflow === "object" ? workflow : {};
	const outputIds = [...(outputNodeIds || [])].map(String);
	if (!outputIds.length) return { pass: false, outputs: [] };
	const checkOutput = (outputId) => {
		const compositors = new Set();
		const collect = (id, visiting = new Set()) => {
			if (!id || visiting.has(id)) return;
			const node = nodes[id];
			if (!node || typeof node !== "object") return;
			if (isCompositeNode(node)) compositors.add(String(id));
			const nextVisiting = new Set(visiting);
			nextVisiting.add(id);
			for (const value of Object.values(node.inputs || {})) for (const linkedId of linkedNodeIds(value)) collect(linkedId, nextVisiting);
		};
		collect(outputId);
		for (const compositorId of compositors) {
			const node = nodes[compositorId];
			const entries = Object.entries(node.inputs || {});
			const background = entries.filter(([key]) => /destination|background|plate|base/i.test(key));
			const source = entries.filter(([key]) => /source|foreground|overlay|subject|image2|video/i.test(key));
			const mask = entries.filter(([key]) => /mask|alpha|matte/i.test(key));
			const reaches = (entries, predicate) => entries.some(([, value]) => linkedNodeIds(value).some((id) => reachesNode(nodes, id, predicate)));
			// A TrackToMask node by itself is not proof of a subject mask: a stale
			// graph can feed it unrelated track data (or a static all-white mask).
			// Require its SAM3_VideoTrack input to be derived from the H3 frames so
			// the compositor cannot silently paste an untracked/generated scene.
			const reachesTrackedMask = (id, visiting = new Set()) => {
				if (!id || visiting.has(id)) return false;
				const candidate = nodes[id];
				if (!candidate || typeof candidate !== "object") return false;
				const nextVisiting = new Set(visiting);
				nextVisiting.add(id);
				if (/sam3[_-]?videotrack/i.test(String(candidate.class_type || ""))) {
					return linkedNodeIds(candidate.inputs?.images).some((imageId) => reachesNode(nodes, imageId, isH3Node));
				}
				if (/sam3[_-]?tracktomask/i.test(String(candidate.class_type || ""))) {
					return linkedNodeIds(candidate.inputs?.track_data).some((trackId) => reachesTrackedMask(trackId, nextVisiting));
				}
				return Object.values(candidate.inputs || {}).some((value) => linkedNodeIds(value).some((linkedId) => reachesTrackedMask(linkedId, nextVisiting)));
			};
			const hasTrackedMask = mask.some(([, value]) => linkedNodeIds(value).some((id) => reachesTrackedMask(id)));
			if (reaches(background, isLoadImageNode) && reaches(source, isH3Node) && hasTrackedMask) {
				return { pass: true, outputId, compositorId, classType: String(node.class_type || "") };
			}
		}
		return { pass: false, outputId };
	};
	const outputs = outputIds.map(checkOutput);
	return { pass: outputs.every((output) => output.pass), outputs, ...(outputs.length === 1 ? outputs[0] : {}) };
}

function replaceWorkflowInputs(value, prompt, imageName, width, height, { h3Only = false, h3Context = false } = {}) {
	if (Array.isArray(value)) return value.map((item) => replaceWorkflowInputs(item, prompt, imageName, width, height, { h3Only, h3Context }));
	if (!value || typeof value !== "object") {
		if (typeof value !== "string") return value;
		if (/PROMPT|paste your/i.test(value)) return prompt;
		return value;
	}
	const output = {};
	const h3Node = /minimax.?h3|h3.*video/i.test(String(value.class_type || ""));
	// The prompt lives under the H3 node's `inputs` object in API exports. Carry
	// a narrow target flag into that child object, while leaving prompts on
	// unrelated SAM3/tracker nodes untouched.
	const targetH3Prompt = h3Context || h3Node;
	for (const [key, item] of Object.entries(value)) {
		if (key === "image" && typeof item === "string" && /loadimage/i.test(String(value.class_type || ""))) output[key] = imageName;
		// Workflow exports often contain a real example sentence rather than the
		// literal PROMPT marker. Replace every node prompt so the H3 preservation
		// contract cannot be bypassed by a stale saved sentence.
		else if (key === "prompt" && typeof item === "string" && (!h3Only || targetH3Prompt)) output[key] = prompt;
		else if ((key === "length" || key === "width" || key === "height") && Number.isInteger(Number(item))) output[key] = key === "length" ? Number(item) : (key === "width" ? width : height);
		else output[key] = replaceWorkflowInputs(item, prompt, imageName, width, height, { h3Only, h3Context: targetH3Prompt });
	}
	return output;
}

function createComfy(env, fetchImpl) {
	const base = env.COZYCLAY_COMFY_URL?.replace(/\/$/, "");
	const workflowPath = env.COZYCLAY_COMFY_WORKFLOW;
	return {
		id: "comfy", name: "ComfyUI",
		configured: () => Boolean(base && workflowPath),
		async generate({ prompt, imageDataUrl, durationSeconds, aspect, signal }) {
			// Read the graph for every request. Comfy users commonly save a new
			// H3 graph (for example, after adding the compositor lock) while this
			// server stays alive; caching would silently keep submitting the old
			// topology and bypass the current first-frame/output contract.
			const workflow = JSON.parse(await (await import("node:fs/promises")).readFile(workflowPath, "utf8"));
			const h3 = isH3Workflow(workflow);
			const preferredOutputs = h3 ? preferredVideoOutputNodes(workflow) : new Set();
			if (h3 && !hasFirstFrameCondition(workflow)) {
				throw h3GuardError("H3 workflow must connect the uploaded image to the first_frame input; refusing an unlocked camera/background run.", "missing-first-frame");
			}
			if (h3 && !preferredOutputs.size) {
				throw h3GuardError("H3 workflow must expose a final SaveVideo/VideoCombine output; refusing an unverified camera/background run.", "missing-final-output");
			}
			const sceneComposite = h3 ? hasH3SceneComposite(workflow, preferredOutputs) : { pass: true };
			if (h3 && !sceneComposite.pass) {
				throw h3GuardError("H3 workflow must composite the generated subject over the uploaded plate with a tracked mask before final video output; refusing an unlocked camera/background run.", "missing-compositor");
			}
			const form = new FormData();
			form.append("image", dataUrlBlob(imageDataUrl), "cozyclay-frame.png");
			form.append("overwrite", "true");
			const uploaded = await fetchImpl(`${base}/upload/image`, { method: "POST", body: form, signal }).then(jsonResponse);
			const imageName = uploaded.name || uploaded.filename;
			if (!imageName) throw new Error("ComfyUI did not return an uploaded filename.");
			const { width, height } = comfyDimensionsForAspect(aspect);
			const promptGraph = replaceWorkflowInputs(workflow, h3 ? buildH3LockedPrompt(prompt) : prompt, imageName, width, height, { h3Only: h3, h3Context: false });
			const queued = await fetchImpl(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: promptGraph, client_id: `cozyclay-${Date.now()}` }), signal }).then(jsonResponse);
			if (!queued.prompt_id) throw new Error("ComfyUI did not return a prompt id.");
			const deadline = Date.now() + 15 * 60 * 1000;
			let history;
			while (Date.now() < deadline) {
				history = await fetchImpl(`${base}/history/${encodeURIComponent(queued.prompt_id)}`, { signal }).then(jsonResponse);
				const entry = history[queued.prompt_id] || history;
				if (entry?.outputs && Object.keys(entry.outputs).length) {
					for (const [nodeId, node] of Object.entries(entry.outputs)) {
						if (preferredOutputs.size && !preferredOutputs.has(String(nodeId))) continue;
						for (const output of Object.values(node || {})) {
						const files = Array.isArray(output) ? output : [output];
						for (const file of files) if (file?.filename && /\.(mp4|webm|gif|mov)$/i.test(file.filename)) {
							const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
							const response = await fetchImpl(`${base}/view?${query}`, { signal });
							if (!response.ok) throw new Error(`ComfyUI video fetch failed (${response.status}).`);
							const bytes = Buffer.from(await response.arrayBuffer());
							const dimensions = findDimensions(entry, width, height);
							let preservation;
							if (h3) {
								preservation = await inspectH3Output({ imageDataUrl, videoBytes: bytes, expectedWidth: width, expectedHeight: height, compositorVerified: sceneComposite.pass });
								if (!preservation.pass) {
									const { worst } = preservation;
									throw Object.assign(new Error(`H3 preservation failed: background/camera drift p95=${worst.p95Rgb.toFixed(1)} RGB, mean=${worst.meanRgb.toFixed(1)} RGB.`), { code: "h3-preservation-failed", preservation });
								}
							}
			return { mp4Base64: bytes.length <= MAX_INLINE_VIDEO ? bytes.toString("base64") : undefined, url: bytes.length > MAX_INLINE_VIDEO ? `${base}/view?${query}` : undefined, width: dimensions.width, height: dimensions.height, seconds: dimensions.seconds ?? durationSeconds, ...(preservation ? { preservation: { ...preservation, compositor: sceneComposite } } : {}) };
						}
						}
					}
				}
				await sleep(2000, signal);
			}
			throw new Error("ComfyUI video generation timed out.");
		},
	};
}

function createFal(env, fetchImpl) {
	const model = env.FAL_MODEL || DEFAULT_FAL_VIDEO_MODEL;
	return {
		id: "fal", name: "Fal.ai", model,
		get resolution() { return env.FAL_RESOLUTION || falVideoContract(model).defaultResolution; },
		configured: () => Boolean(env.FAL_KEY),
		async generate({ prompt, imageDataUrl, lastFrameDataUrl, durationSeconds, aspect, signal }) {
			const contract = validateFalVideoRequest({ model, durationSeconds, aspect });
			const resolution = this.resolution;
			if (!contract.resolution.includes(resolution)) throw Object.assign(new Error(`Fal model ${model} resolution must be one of ${contract.resolution.join(", ")}.`), { code: "fal-invalid-request" });
			const body = contract.aspectFromImage
				? { prompt: buildH3LockedPrompt(prompt), image_url: imageDataUrl, ...(lastFrameDataUrl ? { end_image_url: lastFrameDataUrl } : {}), duration: Number(durationSeconds), resolution, prompt_expansion_mode: "disabled" }
				: { prompt, image_url: imageDataUrl, duration: String(durationSeconds), aspect_ratio: aspect, camera_fixed: env.FAL_CAMERA_FIXED !== "0", resolution };
			const queued = await fetchImpl(`https://queue.fal.run/${model}`, { method: "POST", headers: { authorization: `Key ${env.FAL_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body), signal }).then(jsonResponse);
			let status = queued;
			const deadline = Date.now() + 15 * 60 * 1000;
			while (Date.now() < deadline) {
				if (status.video?.url || status.output?.video?.url) break;
				if (status.status === "FAILED") throw new Error(status.error || "Fal.ai video generation failed.");
				if (status.status === "COMPLETED") {
					const resultUrl = status.response_url || queued.response_url;
					if (!resultUrl) throw new Error("Fal.ai did not return a result URL.");
					status = await fetchImpl(resultUrl, { headers: { authorization: `Key ${env.FAL_KEY}` }, signal }).then(jsonResponse);
					break;
				}
				const statusUrl = status.status_url || queued.status_url;
				if (!statusUrl) throw new Error("Fal.ai did not return a status URL.");
				status = await fetchImpl(statusUrl, { headers: { authorization: `Key ${env.FAL_KEY}` }, signal }).then(jsonResponse);
				if (status.status !== "COMPLETED" && status.status !== "FAILED" && !status.video?.url && !status.output?.video?.url) await sleep(2000, signal);
			}
			const url = status.video?.url || status.output?.video?.url || status.video_url;
			if (!url) throw new Error("Fal.ai did not return a video URL.");
			const response = await fetchImpl(url, { signal });
			if (!response.ok) throw new Error(`Fal.ai video fetch failed (${response.status}).`);
			const bytes = Buffer.from(await response.arrayBuffer());
			const metadata = await probeVideoBytes(bytes);
			return { mp4Base64: bytes.length <= MAX_INLINE_VIDEO ? bytes.toString("base64") : undefined, url: bytes.length > MAX_INLINE_VIDEO ? url : undefined, ...metadata };
		},
	};
}

export function createVideoAdapters(env = process.env) {
	const fetchImpl = globalThis.fetch;
	return [createComfy(env, fetchImpl), createFal(env, fetchImpl)];
}
