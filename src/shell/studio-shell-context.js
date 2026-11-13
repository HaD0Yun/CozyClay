import { createContext, useContext } from "react";
import { playbackFrame, usePlaybackSnapshot } from "../motion/playback-frame-store.js";

// App owns the document/domain wiring. Region components consume this one
// render snapshot and call its named actions; they never acquire domain state
// or call authored-state writers themselves. Ref cells keep their identity.
//
// In addition to the extracted controls, the public region contract includes:
// - spawnCharacter/addSceneObject/beginAssetDrag/runStudioAction, mode/IK tools;
// - saveStatus, all exporters, exportStatus.cancel/retry, setToast and
//   subscribeToasts (the Content Log can tee notifications without replacing UI);
// - generation, blocks/refine, takes/recipe and preserve strength;
// - agentOpen/toggleAgent, preferencesOpen/setPreferencesOpen;
// - liveHubStatus, flySpeed (the navigation multiplier, not metres per second);
// - castStyle ("rig" | "capsule" | "hybrid"), which orders Add > Character;
// - previsMode ("storyboard" | "animation"), sceneRevision (bumps on every
//   authored edit) and capturePanelThumbnail(shot) (the shot's first frame as
//   a PNG data URL, or null) for the Board dock tab.
export const StudioShellContext = createContext(null);

export function useStudioShell() {
	return useContext(StudioShellContext);
}

export function useStudioPlaybackFrame() {
	return usePlaybackSnapshot(playbackFrame);
}
