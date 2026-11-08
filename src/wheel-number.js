// Wheel over a number field in the timeline camera bar (Speed, Point height,
// Damping, Look-ahead) steps it by its own `step`, clamped to min/max. One
// non-passive document listener the Studio shell installs (StudioShell.jsx):
// React registers onWheel as passive, so it could not stop the page scroll.
// stepUp/stepDown change the DOM value behind React's value tracker, so the
// bubbling "input" event reaches each field's onChange like typing does.
const FIELD = ".tl-camera-editor input[type='number']:not(:disabled)";
const STEP_PX = 40; // trackpad pixels per step; a mouse notch is one step

export function installWheelNumber(doc = globalThis.document) {
	if (!doc) return () => {};
	let acc = 0;
	let last = null;
	const onWheel = (event) => {
		const input = event.target?.closest?.(FIELD);
		if (!input || event.deltaY === 0) return;
		event.preventDefault();
		if (input !== last) {
			acc = 0;
			last = input;
		}
		acc += event.deltaMode === 0 ? event.deltaY : Math.sign(event.deltaY) * STEP_PX;
		const steps = Math.trunc(acc / STEP_PX);
		if (steps === 0) return;
		acc -= steps * STEP_PX;
		const before = input.value;
		// Wheel up (negative deltaY) raises the value.
		if (steps < 0) input.stepUp(-steps);
		else input.stepDown(steps);
		if (input.value !== before) input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	doc.addEventListener("wheel", onWheel, { passive: false });
	return () => doc.removeEventListener("wheel", onWheel);
}
