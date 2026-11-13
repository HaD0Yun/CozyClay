import { isPlaygroundEmbed } from "./playground.js";

export function useEmbedBridge() {
	const embedMode = ["scene", "playview"].includes(new URLSearchParams(globalThis.location?.search || "").get("embed"));
	// The playground iframe an external page hosts: full studio interaction with the
	// project chrome hidden and saving off (see playground.js).
	const playgroundMode = isPlaygroundEmbed(globalThis.location?.search);
	return { embedMode, playgroundMode };
}
