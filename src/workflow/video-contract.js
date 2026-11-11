// Fal H3 Max Turbo I2V schema: https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api
export const DEFAULT_FAL_VIDEO_MODEL = "minimax/h3-max-turbo/image-to-video";
const COMFY_VIDEO_ASPECTS = Object.freeze(["16:9", "9:16", "1:1", "21:9", "12:7"]);

function falVideoContract(model = DEFAULT_FAL_VIDEO_MODEL) {
	if (model === DEFAULT_FAL_VIDEO_MODEL) return { name: "H3 Max Turbo", aspectFromImage: true, cameraLocked: true, aspects: [], minDuration: 5, maxDuration: 15, integerDuration: true, defaultDuration: 5, resolution: ["480P", "768P", "1080P"], defaultResolution: "480P" };
	if (model === "fal-ai/bytedance/seedance/v1/pro/image-to-video") return { name: "Seedance v1 Pro", aspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], minDuration: 2, maxDuration: 12, defaultAspect: "16:9", defaultDuration: 5, resolution: ["480p", "720p", "1080p"], defaultResolution: "1080p" };
	throw Object.assign(new Error(`Unsupported Fal video model: ${model}. Use ${DEFAULT_FAL_VIDEO_MODEL}.`), { code: "fal-invalid-request" });
}

export function videoFormContract(provider = "comfy", model = DEFAULT_FAL_VIDEO_MODEL) {
	if (provider === "fal") return falVideoContract(model);
	return { aspects: COMFY_VIDEO_ASPECTS, minDuration: 1, maxDuration: 15, defaultAspect: "16:9", defaultDuration: 5 };
}

export function normalizeVideoForm(provider, values = {}, model = DEFAULT_FAL_VIDEO_MODEL) {
	const contract = videoFormContract(provider, model);
	const duration = Number(values.duration_seconds);
	const bounded = Number.isFinite(duration) ? Math.min(contract.maxDuration, Math.max(contract.minDuration, duration)) : contract.defaultDuration;
	return {
		...values,
		aspect: contract.aspectFromImage ? "source" : contract.aspects.includes(values.aspect) ? values.aspect : contract.defaultAspect,
		duration_seconds: contract.integerDuration ? Math.round(bounded) : bounded,
	};
}
