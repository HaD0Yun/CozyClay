/* global __COZYCLAY_POSER_MODEL__ */
// The one place the Auto Pose network file is configured. The 83 MB model is not in git. A build copies it into dist
// (and so into the npm package) when public/models/cozy-poser-v1.onnx is present; a build without it, like the hosted
// site, says Auto Pose is not available there instead of trying to download it. build-plugin.js sets the flag.
export const POSER_MODEL = Object.freeze({
	url: "/models/cozy-poser-v1.onnx",
	sha256: "9af181e672d725635701f231b5b093c51e4957f4555b8856ddf35c054d57dc72",
	bytes: 83234732,
	cacheName: "cozy-poser-v1",
	// whether this build ships the file; outside a Vite build (Node tests, tools) the file is expected
	bundled: typeof __COZYCLAY_POSER_MODEL__ === "undefined" ? true : __COZYCLAY_POSER_MODEL__,
});
