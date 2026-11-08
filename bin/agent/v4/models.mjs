// The v4 motion engine's entries in the Studio Agent panel's model picker.
// "v4/claude-opus-5-5" runs the v4 tools in one Claude Code session (studio-turn.mjs);
// "v4pi/claude-opus-5-5" runs the same tools and prompt on CozyClay's pi loop (pi-turn.mjs).
// The route sends each key to its engine and every other key to the old engine.

export const V4_MODEL_KEY = "v4/claude-opus-5-5";
export const V4_PI_MODEL_KEY = "v4pi/claude-opus-5-5";

/** True for the model key the v4 Claude Code engine runs. */
export const isV4Model = key => key === V4_MODEL_KEY;

/** True for the model key the v4 pi-loop engine runs. */
export const isV4PiModel = key => key === V4_PI_MODEL_KEY;

const V4_MODEL = { id: "claude-opus-5-5", key: V4_MODEL_KEY, label: "Opus 5.5 (v4 motion, Claude Code)", efforts: ["high", "xhigh", "max", "medium", "low"], defaultEffort: "high", input: ["text", "image"] };
const V4_PI_MODEL = { id: "claude-opus-5-5", key: V4_PI_MODEL_KEY, label: "Opus 5.5 (v4 motion, pi loop)", efforts: ["high", "xhigh", "max", "medium", "low"], defaultEffort: "high", input: ["text", "image"] };

/**
 * /agent/models with the v4 provider added after the others.
 * v4 runs on the CLIProxyAPI sign-in, so it is listed only while that provider is signed in,
 * with its sign-in state and source. A listing without a signed-in cliproxy comes back as it was.
 */
export function withV4Models(listing) {
	const cliproxy = Array.isArray(listing?.providers) ? listing.providers.find(provider => provider?.id === "cliproxy") : null;
	if (!cliproxy?.signedIn) return listing;
	const provider = { id: "v4", label: "CozyClay v4 motion", signedIn: cliproxy.signedIn, authSource: cliproxy.authSource ?? null, models: [{ ...V4_MODEL }, { ...V4_PI_MODEL }] };
	return { ...listing, providers: [...listing.providers, provider], models: [...(Array.isArray(listing.models) ? listing.models : []), { ...V4_MODEL, id: V4_MODEL_KEY }, { ...V4_PI_MODEL, id: V4_PI_MODEL_KEY }] };
}
