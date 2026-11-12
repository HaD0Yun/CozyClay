// A character whose FBX fails to load (#1197): drei's useFBX rejects with
// Error("Could not load <url>: <message>"). The stage must keep rendering: the
// failed body falls back to the proxy figure with a console.warn, the rest of
// the cast stays mounted, and the error reaches neither the root crash screen
// (src/error-boundary.jsx) nor the process as an uncaught error.
//
// The real chain runs in Node: vite loads src/stage-characters.jsx, the real
// @react-three/fiber reconciler mounts it on a stub renderer, and the real
// useFBX -> useLoader -> FBXLoader fetches a URL that refuses the connection.
import { Component, Suspense, createElement as h } from "react";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

let failures = 0;
const ok = (name, pass, detail = "") => { console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : ` -- ${detail}`}`); if (!pass) failures += 1; };

const uncaught = [];
const onUncaught = (caught) => uncaught.push(caught);
const warnings = [];
const warn = console.warn, error = console.error;
console.warn = (...args) => warnings.push(args.map(String).join(" "));
console.error = () => {};

const server = await createServer({ configFile: false, logLevel: "silent", root: fileURLToPath(new URL("../", import.meta.url)),
	server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom",
	// drei's and three's barrels and app-stage.jsx (the whole app) pull modules Node cannot load (https imports);
	// point each at the one module the stage uses.
	plugins: [{ name: "stage-barrels", enforce: "pre",
		load(id) { return id.endsWith("/src/app-stage.jsx") ? 'export { defaultCharacterTint } from "./stage-startup-defaults.js";' : null; },
		transform(code, id) {
			if (!id.includes("/src/")) return null;
			return code
				.replace('import { SkeletonUtils } from "three/examples/jsm/Addons.js";', 'import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";')
				.replace('from "@react-three/drei";', 'from "@react-three/drei/core/Fbx.js";');
		} }] });
try {
	const { Character } = await server.ssrLoadModule("/src/stage-characters.jsx");
	const { createRoot, extend } = await import("@react-three/fiber");
	extend(await import("three")); // what <Canvas> does before it mounts

	// Stands in for the root crash screen: whatever reaches it is a crash.
	const crashes = [];
	class CrashScreen extends Component {
		constructor(props) { super(props); this.state = { error: null }; }
		static getDerivedStateFromError(caught) { return { error: caught }; }
		componentDidCatch(caught) { crashes.push(caught); }
		render() { return this.state.error ? null : this.props.children; }
	}

	const badUrl = "http://127.0.0.1:9/missing-character.fbx";
	const stubRenderer = { render() {}, setSize() {}, setPixelRatio() {}, domElement: { style: {} }, shadowMap: { enabled: false } };
	const canvas = { style: {}, addEventListener() {}, removeEventListener() {} };
	const root = createRoot(canvas);
	let state = null;
	await root.configure({ gl: stubRenderer, frameloop: "never", size: { width: 64, height: 64, top: 0, left: 0 }, onCreated: (s) => { state = s; } });
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUncaught);
	const props = { rot: 0, tint: "#c9a27e", pose: null, posture: "stand" };
	root.render(h(CrashScreen, null, h(Suspense, { fallback: null },
		h(Character, { ...props, key: "bad", character: { id: "bad", model: "y-bot" }, url: badUrl, position: [0, 0, 0], pickId: "bad" }),
		h(Character, { ...props, key: "proxy", character: { id: "proxy", model: "proxy-figure" }, model: "proxy-figure", position: [2, 0, 0], pickId: "proxy" }),
	)));

	// The load settles once the refused connection comes back; give the retry render time to commit.
	const deadline = Date.now() + 8000;
	const picks = () => {
		const found = [];
		state?.scene.traverse((node) => { if (node.userData?.characterPick) found.push(node.userData.characterPick); });
		return found;
	};
	while (Date.now() < deadline && !crashes.length && !uncaught.length && !warnings.some((line) => line.includes(badUrl))) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await new Promise((resolve) => setTimeout(resolve, 200));

	ok("the failed load does not reach the root crash screen", crashes.length === 0, crashes.map((c) => c.message).join(" | "));
	ok("the failed load is not an uncaught error", uncaught.length === 0, uncaught.map((c) => c?.message).join(" | "));
	ok("the failed load warns on the console and names the model URL", warnings.some((line) => line.includes(badUrl)), JSON.stringify(warnings));
	const mounted = picks();
	ok("the rest of the cast stays on the stage", mounted.includes("proxy"), JSON.stringify(mounted));
	ok("the failed character shows the proxy figure in its place", mounted.includes("bad"), JSON.stringify(mounted));
	root.unmount();
} finally {
	process.off("uncaughtException", onUncaught);
	process.off("unhandledRejection", onUncaught);
	console.warn = warn;
	console.error = error;
	await server.close();
}
console.log(failures === 0 ? "all character-load-fallback checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
