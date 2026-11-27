// The Gemini subscription lane (google-antigravity): a Google AI subscription (Free, Plus, Pro,
// Ultra) used through Google's official, unmodified antigravity-acp agent over the Agent Client
// Protocol — the integration Google documents for editors (antigravity.google/docs/install,
// "Agent configuration (auth.type)": oauth-personal). Built like the Claude lane
// (anthropic-subscription.mjs): a normal pi provider whose `api.stream` never calls a Google
// endpoint itself; google-antigravity-stream.mjs drives the binary.
//
// One difference from the Claude lane, on purpose: CozyClay holds no Google token. Sign-in runs
// inside the binary (it opens the browser, receives the callback, keeps the tokens in the OS
// keyring). What pi stores for this provider is a marker that says "signed in through
// antigravity-acp" with empty token fields; a turn asks the binary to authenticate and fails as a
// sign-in problem (failure code auth) when the binary says its sign-in has ended.
import { ensureAntigravityAcp } from "./antigravity-acp-binary.mjs";
import { authenticate, startAntigravity } from "./google-antigravity-agent.mjs";
import { createAntigravityStream } from "./google-antigravity-stream.mjs";

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
export const ANTIGRAVITY_PROVIDER_NAME = "Gemini (Google AI subscription)";
// Google's current Antigravity lineup (antigravity.google/docs/models), Gemini only; pi's Gemini
// catalogue supplies the context windows and thinking levels.
export const ANTIGRAVITY_MODEL_IDS = Object.freeze(["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen"]);
const MARKER_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** The credential pi stores: no token, only where the sign-in lives. */
export function signInMarker(now = Date.now()) {
	return { type: "oauth", access: "", refresh: "", expires: now + MARKER_LIFETIME_MS, via: "antigravity-acp" };
}

/**
 * The binary's own Google sign-in, as pi's login step: fetch the official binary if needed, start
 * it, ask for oauth-personal and wait while the user signs in in the browser it opened.
 */
export function createAntigravityLogin({ env = process.env, ensure = ensureAntigravityAcp, start = startAntigravity, version } = {}) {
	return async function login(interaction = {}) {
		const notify = (event) => { try { interaction.notify?.(event); } catch { /* the card is best-effort */ } };
		await ensure({ env, notify });
		let connection;
		const onAbort = () => connection?.close();
		interaction.signal?.addEventListener?.("abort", onAbort, { once: true });
		try {
			const started = await start({
				env, version,
				onAuthLink: (url) => notify({ type: "auth_url", url, instructions: "Google's Antigravity agent could not open a browser. Open this Google sign-in page to continue." }),
			});
			connection = started.connection;
			if (interaction.signal?.aborted) throw new Error("The login was cancelled.");
			notify({ type: "info", message: "Google's Antigravity agent is opening Google sign-in in your browser. Finish signing in there." });
			await authenticate(connection);
			return signInMarker();
		} catch (error) {
			if (interaction.signal?.aborted) throw new Error("The login was cancelled.", { cause: error });
			throw error;
		} finally {
			interaction.signal?.removeEventListener?.("abort", onAbort);
			connection?.close();
		}
	};
}

export async function googleAntigravityProvider({ env = process.env, login, stream } = {}) {
	const [{ googleProvider }, { createProvider }] = await Promise.all([
		import("@earendil-works/pi-ai/providers/google"),
		import("@earendil-works/pi-ai"),
	]);
	const catalogue = googleProvider().getModels();
	const models = ANTIGRAVITY_MODEL_IDS.map((id) => catalogue.find((model) => model.id === id)).filter(Boolean).map((model) => ({
		...model,
		provider: ANTIGRAVITY_PROVIDER_ID,
		baseUrl: undefined,
		// the subscription pays; no per-token price applies to this lane
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	const streamImpl = stream ?? createAntigravityStream({ env });
	return createProvider({
		id: ANTIGRAVITY_PROVIDER_ID,
		name: ANTIGRAVITY_PROVIDER_NAME,
		auth: {
			oauth: {
				name: ANTIGRAVITY_PROVIDER_NAME,
				loginLabel: "Sign in with Google (Gemini via Antigravity)",
				isSubscription: true,
				login: login ?? createAntigravityLogin({ env }),
				// nothing to refresh here: the binary refreshes its own tokens
				refresh: async () => signInMarker(),
				toAuth: async () => ({}),
			},
		},
		models,
		api: { stream: streamImpl, streamSimple: streamImpl },
	});
}
