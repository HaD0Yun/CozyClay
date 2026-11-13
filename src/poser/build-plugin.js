// Build-time Vite plugin (Node only; the app never imports it). Tells the app whether this build ships the Auto Pose
// model: Vite copies public/ into dist, so the file is in the build (and the npm package) exactly when it is present
// here. The flag is read from the file's presence; nothing is downloaded or hashed.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { POSER_MODEL } from "./config.js";

export function poserModelFlag() {
	return {
		name: "cozyclay-poser-model-flag",
		config(config) {
			const present = existsSync(resolve(config.root ?? process.cwd(), "public", POSER_MODEL.url.replace(/^\//, "")));
			return { define: { __COZYCLAY_POSER_MODEL__: JSON.stringify(present) } };
		},
	};
}
