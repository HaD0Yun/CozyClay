// A UI door into the bus (#1040, #1185). The domain run() helpers throw a StudioProtocolError when the bus refuses,
// and agent and command paths rely on that throw. A command the UI sends on its own (a cross-tab subscription, a
// gesture end, a panel handler) has nobody above it to catch, so its refusal ends here: logged, the state left as
// the bus left it, never in window.onerror. The bus already counts the refusal as studio:refused.
export function settleUiRefusal(what, action) {
	const refused = error => {
		if (error?.name !== "StudioProtocolError") throw error;
		console.warn(`[cozyclay] ${what}`, error.code, error.message);
		return null;
	};
	try {
		const result = action();
		return typeof result?.then === "function" ? result.then(undefined, refused) : result;
	} catch (error) {
		return refused(error);
	}
}
