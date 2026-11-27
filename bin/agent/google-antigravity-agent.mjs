// Starting Google's official antigravity-acp for the google-antigravity lane and picking its
// native "Log in with Google" (oauth-personal) sign-in. CozyClay holds no Google credential: the
// binary signs in, stores and refreshes its own tokens; CozyClay only learns "signed in" (the
// `authenticate` request resolved) or "needs sign-in" (the binary started its browser login).
import { initializeParams, openAcpConnection } from "./acp-connection.mjs";
import { locateAntigravityAcp } from "./antigravity-acp-binary.mjs";

const OAUTH_METHOD = "oauth-personal";
// The binary logs this when it has no valid sign-in and starts its browser login.
const SIGN_IN_STARTED = /Launching browser login flow|Credentials missing or invalid/i;
// ...and prints its own Google sign-in link when it cannot open a browser itself.
const AUTH_LINK = /Open the following link to authenticate[^:]*:\s*(https:\/\/accounts\.google\.com\/\S+)/i;

// Environment the binary must not inherit: an API key, ADC or gateway would make it bill something
// other than the user's Google AI subscription sign-in (the API-key Gemini lane stays its own lane).
const SCRUBBED = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "AGY_ADC_AUTH", "GOOGLE_GEMINI_BASE_URL",
	"AGY_LLM_GATEWAY_URL", "GOOGLE_APPLICATION_CREDENTIALS"];
function childEnvironment(parent = process.env) {
	const env = { ...parent };
	for (const name of SCRUBBED) delete env[name];
	return env;
}

export function signInError(message = "Your Google sign-in for Gemini has ended.") {
	// "401" so the runner's classifier and the panel read it as a sign-in problem (failure code auth).
	return Object.assign(new Error(`401 ${message} Sign in with Gemini (Google AI subscription) from the agent panel again.`), { code: "AUTH_REQUIRED", status: 401 });
}

/**
 * Spawns and initializes the binary. `onSignInStarted()` fires when the binary begins its own
 * browser login, `onAuthLink(url)` when it prints its sign-in link. Resolves `{ connection, init }`.
 */
export async function startAntigravity({ env = process.env, cwd, locate = locateAntigravityAcp, open = openAcpConnection, version,
	onNotification, onRequest, onSignInStarted, onAuthLink } = {}) {
	const binary = locate({ env });
	if (!binary.command) {
		throw signInError(binary.supported === false
			? "Google publishes no Antigravity agent for this computer."
			: "Google's Antigravity agent is not installed yet.");
	}
	const connection = open({
		command: binary.command,
		args: binary.args,
		env: childEnvironment(env),
		cwd,
		onNotification,
		onRequest,
		onStderr: (line) => {
			const link = AUTH_LINK.exec(line);
			if (link) onAuthLink?.(link[1]);
			else if (SIGN_IN_STARTED.test(line)) onSignInStarted?.();
		},
	});
	try {
		const init = await connection.request("initialize", initializeParams(version));
		const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
		if (!methods.some((method) => method?.id === OAUTH_METHOD)) {
			throw Object.assign(new Error("This Antigravity agent offers no Google account sign-in."), { code: "CAPABILITY_MISSING" });
		}
		return { connection, init, binary };
	} catch (error) {
		connection.close();
		throw error;
	}
}

/** Asks the binary to use its Google account sign-in; it opens the browser itself when needed. */
export function authenticate(connection) {
	return connection.request("authenticate", { methodId: OAUTH_METHOD });
}
