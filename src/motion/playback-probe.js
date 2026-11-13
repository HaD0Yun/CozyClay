import { sampleAt } from "../sample-at.js";

export function playbackProbe(probe, frame, fallback) {
	const sampled = probe.scene ? sampleAt(probe.scene, null, frame).subject : null;
	const carried = sampled && probe.carry ? probe.carry(sampled, frame) : sampled;
	return carried ?? fallback;
}

export function probeVisibility(vector, camera, subject, height) {
	let visible = false;
	for (const y of [0.1, height * 0.94]) {
		vector.set(subject.x, (subject.y ?? 0) + y, subject.z).project(camera);
		if (vector.z < 1 && Math.abs(vector.x) <= 1 && Math.abs(vector.y) <= 1) visible = true;
	}
	return visible;
}
