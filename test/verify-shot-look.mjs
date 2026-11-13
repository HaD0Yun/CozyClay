#!/usr/bin/env node
// Studio look-through flies the shot camera with the free camera's bindings.
// The chrome-free player stays on enterPreview (embed / playground rail).
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition) {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
	if (!condition) failures += 1;
}

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const dualview = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");
const controls = readFileSync(new URL("../src/controls.jsx", import.meta.url), "utf8");

expect(
	"enterShotLook turns on look-through without the player",
	/function enterShotLook\(\) \{[^}]*setPreview\(false\);[^}]*setLookThroughShot\(true\);/s.test(app) &&
	!/function enterShotLook\(\) \{[^}]*setPreview\(true\);/s.test(app),
);
expect("the PiP expand enters shot-look", app.includes("onClick={enterShotLook}"));
expect("the PiP no longer opens the player", !app.includes("onClick={enterPreview}"));
expect(
	"FlyControls stay enabled outside preview and aim recording and bind to the shot camera while looking through",
	// Sculpt owns its turntable; a rail recording owns position and mouse aim.
	app.includes("enabled={!posing && !playMode && !sculptMode && !railRecording.active}") &&
	app.includes("camRef={ikMode ? poserCamRef : lookThroughShot ? shotCamRef : editorCamRef}") &&
	controls.includes("right-drag") &&
	controls.includes("WASD"),
);
expect(
	"flying the shot camera commits framing",
	app.includes("onCameraChange={lookThroughShot && !ikMode ? commitManualCameraFraming : undefined}"),
);
expect(
	"DualRender's editing branch is the look-through draw",
	dualview.includes("Look-through") &&
	dualview.includes("fly the recording lens"),
);
expect("Escape still leaves look-through", app.includes('if (event.key === "Escape") exitPreview();'));
expect(
	"switching to Camera does not kick the operator out of shot-look",
	app.includes("else if (lookThroughShot && next !== \"camera\") exitPreview();") &&
	!app.includes("Picking a department is an editing act: it always lands in the editor"),
);

if (failures > 0) {
	console.error(`${failures} FAILURES`);
	process.exit(1);
}
console.log("verify-shot-look: all checks passed");
