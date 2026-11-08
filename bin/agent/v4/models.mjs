// The v4 motion engine's entry in the Studio Agent panel's model picker.
// The option value is "v4/claude-opus-5-5"; the route sends that key to the v4 engine
// (studio-turn.mjs) and every other key to the old engine.

export const V4_MODEL_KEY = "v4/claude-opus-5-5";

/** True for the one model key the v4 engine runs. */
export const isV4Model = key => key === V4_MODEL_KEY;

const V4_MODEL = { id: "claude-opus-5-5", key: V4_MODEL_KEY, label: "Opus 5.5 (v4 motion, Claude Code)", efforts: ["high", "xhigh", "max", "medium", "low"], defaultEffort: "high", input: ["text", "image"] };

/**
 * /agent/models with the v4 provider added after the others.
 * v4 runs on the CLIProxyAPI sign-in, so it is listed only while that provider is signed in,
 * with its sign-in state and source. A listing without a signed-in cliproxy comes back as it was.
 */
export function withV4Models(listing) {
	const cliproxy = Array.isArray(listing?.providers) ? listing.providers.find(provider => provider?.id === "cliproxy") : null;
	if (!cliproxy?.signedIn) return listing;
	const provider = { id: "v4", label: "CozyClay v4 motion", signedIn: cliproxy.signedIn, authSource: cliproxy.authSource ?? null, models: [{ ...V4_MODEL }] };
	return { ...listing, providers: [...listing.providers, provider], models: [...(Array.isArray(listing.models) ? listing.models : []), { ...V4_MODEL, id: V4_MODEL_KEY }] };
}
