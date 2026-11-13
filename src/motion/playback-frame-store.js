import { useEffect, useSyncExternalStore } from "react";
import { shotIndexAtFrame } from "../cuts.js";

// The playhead lives here, outside React: playback ticks write it and only the
// components that show the frame subscribe, so App does not re-render per frame.
let currentFrame = 0;
const listeners = new Set();
let applyPlaybackFrame = null;

export function playbackFrame() {
	return currentFrame;
}

export function setPlaybackFrame(next) {
	const frame = typeof next === "function" ? next(currentFrame) : next;
	if (!Number.isFinite(frame) || frame === currentFrame) return currentFrame;
	currentFrame = frame;
	for (const listener of listeners) listener();
	return currentFrame;
}

export function advancePlaybackFrame(frameCount, count) {
	const frame = setPlaybackFrame((current) => (current + count) % frameCount);
	applyPlaybackFrame?.(frame);
	return frame;
}

export function registerPlaybackFrameApplier(applier) {
	applyPlaybackFrame = applier;
	return () => {
		if (applyPlaybackFrame === applier) applyPlaybackFrame = null;
	};
}

export function createPlaybackFrameSetter({ getFrameCount, setReactFrame, onFrame }) {
	return (update) => {
		const next = typeof update === "function" ? update(playbackFrame()) : update;
		const frame = Math.max(0, Math.min(getFrameCount() - 1, Math.round(next)));
		setPlaybackFrame(frame);
		setReactFrame(frame);
		onFrame?.(frame);
	};
}

export function commitPlaybackFrame(setReactFrame, onFrame) {
	const frame = playbackFrame();
	setReactFrame(frame);
	onFrame?.(frame);
	return frame;
}

export function usePlaybackSnapshot(getSnapshot) {
	return useSyncExternalStore(subscribePlaybackFrame, getSnapshot, getSnapshot);
}

export function usePlaybackEffects({ playing = false, commit = () => {}, onStop = null } = {}) {
	useEffect(() => {
		if (!playing) {
			commit();
			onStop?.();
		}
		// Runs on play/stop transitions only; commit and onStop are recreated every render.
	}, [playing]);
}

/** The shots domain's timeline frame: React state (owned by the caller) for edits, the store for playback.
 * activeShotIdx subscribes to the store, so it re-renders only when playback crosses a cut. */
export function usePlaybackFrameState({ frameCount, setReactFrame, shots }) {
	const setTlFrame = createPlaybackFrameSetter({ getFrameCount: () => frameCount, setReactFrame });
	const activeShotIdx = usePlaybackSnapshot(() => shotIndexAtFrame(shots, playbackFrame()));
	const activeShot = shots[activeShotIdx] ?? null;
	return { setTlFrame, commitPlaybackFrame: () => commitPlaybackFrame(setReactFrame), activeShotIdx, activeShot };
}

function subscribePlaybackFrame(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
